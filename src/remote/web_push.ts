import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";
import { field, str } from "../json";

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export function subscription(value: unknown): Subscription {
  const endpoint = str(value, "endpoint"),
    keys = field(value, "keys");
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      endpoint.length > 2048 ||
      !(
        host.endsWith(".push.apple.com") ||
        host === "fcm.googleapis.com" ||
        host === "updates.push.services.mozilla.com"
      )
    )
      throw Error();
    const p256dh = str(keys, "p256dh"),
      auth = str(keys, "auth");
    if (!/^[\w-]{87}$/.test(p256dh) || !/^[\w-]{22}$/.test(auth)) throw Error();
    const point = Buffer.from(p256dh, "base64url");
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    if (
      point.length !== 65 ||
      point[0] !== 4 ||
      ecdh.computeSecret(point).length !== 32 ||
      Buffer.from(auth, "base64url").length !== 16
    )
      throw Error();
    return { endpoint, keys: { p256dh, auth } };
  } catch {
    throw Error("InvalidSubscription");
  }
}
export function publicKey(privateKey: string): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  return ecdh.getPublicKey();
}
export function generateKey(): string {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return key.getPrivateKey().toString("base64url");
}
// RFC 8291: one final aes128gcm record; payloads deliberately fit in 4 KiB.
export function encrypt(
  text: string,
  target: Subscription,
  privateKey = generateKey(),
  salt = randomBytes(16),
): Buffer {
  const sender = createECDH("prime256v1");
  sender.setPrivateKey(Buffer.from(privateKey, "base64url"));
  const receiver = Buffer.from(target.keys.p256dh, "base64url"),
    senderPublic = sender.getPublicKey();
  const ikm = hkdfSync(
    "sha256",
    sender.computeSecret(receiver),
    Buffer.from(target.keys.auth, "base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"), receiver, senderPublic]),
    32,
  );
  const key = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const plain = Buffer.concat([Buffer.from(text), Buffer.from([2])]);
  if (plain.length + 16 > 4096 || salt.length !== 16) throw Error("InvalidPushPayload");
  const cipher = createCipheriv("aes-128-gcm", Buffer.from(key), Buffer.from(nonce));
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
export function authorization(endpoint: string, privateKey: string, subject: string, now = Date.now()): string {
  const pub = publicKey(privateKey);
  const key = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
      d: privateKey,
    },
  });
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${encoded({ typ: "JWT", alg: "ES256" })}.${encoded({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject })}`;
  const signature = sign("sha256", Buffer.from(jwt), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${jwt}.${signature}, k=${pub.toString("base64url")}`;
}
export async function send(
  target: Subscription,
  privateKey: string,
  origin: string,
  payload: unknown,
): Promise<number> {
  const response = await fetch(target.endpoint, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: authorization(target.endpoint, privateKey, origin),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "300",
      Urgency: "high",
    },
    body: new Uint8Array(encrypt(JSON.stringify(payload), target)),
  });
  await response.body?.cancel();
  return response.status;
}
