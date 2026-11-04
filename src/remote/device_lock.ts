import { createHash, createPublicKey, verify } from "node:crypto";
export interface DeviceLock {
  id: string;
  key: string;
}
export function deviceLock(value: unknown): DeviceLock {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("key" in value) ||
    typeof value.id !== "string" ||
    typeof value.key !== "string" ||
    !/^[A-Za-z0-9_-]{16,1024}$/.test(value.id)
  )
    throw Error("InvalidInput");
  try {
    const key = createPublicKey({ key: Buffer.from(value.key, "base64url"), type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw Error();
  } catch {
    throw Error("InvalidInput");
  }
  return { id: value.id, key: value.key };
}
export function unlock(lock: DeviceLock, assertion: unknown, origin: string, nonce: string): boolean {
  try {
    if (!assertion || typeof assertion !== "object") return false;
    const read = (key: string) => {
      const value = Reflect.get(assertion, key);
      if (typeof value !== "string" || value.length > 8192) throw Error();
      return Buffer.from(value, "base64url");
    };
    const client = read("clientDataJSON"),
      data = JSON.parse(client.toString("utf8")),
      auth = read("authenticatorData");
    if (
      data.type !== "webauthn.get" ||
      data.origin !== origin ||
      data.challenge !== nonce ||
      data.crossOrigin === true ||
      auth.length < 37 ||
      (auth[32] & 5) !== 5
    )
      return false;
    if (!auth.subarray(0, 32).equals(createHash("sha256").update(new URL(origin).hostname).digest())) return false;
    return verify(
      "sha256",
      Buffer.concat([auth, createHash("sha256").update(client).digest()]),
      { key: Buffer.from(lock.key, "base64url"), type: "spki", format: "der" },
      read("signature"),
    );
  } catch {
    return false;
  }
}
