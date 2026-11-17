import { expect, test, spyOn } from "bun:test";
import { createECDH, createPublicKey, verify } from "node:crypto";
import { authorization, encrypt, generateKey, publicKey, send, subscription } from "./web_push";
const target = {
  endpoint: "https://web.push.apple.com/token",
  keys: {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg", // RFC 8291 example auth secret. gitleaks:allow
  },
};
test("Web Push encryption matches the RFC 8291 published vector byte for byte", () => {
  const encrypted = encrypt(
    "When I grow up, I want to be a watermelon",
    target,
    "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
  );
  expect(encrypted.subarray(86).toString("base64url")).toBe(
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
  );
  expect(encrypted.subarray(0, 16).toString("base64url")).toBe("DGv6ra1nlYgDCS1FRnbzlw");
  expect(encrypted.readUInt32BE(16)).toBe(4096);
  expect(encrypted[20]).toBe(65);
  expect(() => encrypt("x".repeat(4096), target)).toThrow("InvalidPushPayload");
});
test("VAPID JWT signs the push service audience with ES256 and a bounded expiry", () => {
  const privateKey = generateKey(),
    pub = publicKey(privateKey);
  const auth = authorization(target.endpoint, privateKey, "https://mac.example.ts.net:8443", 1_000_000);
  const match = /^vapid t=(.*), k=(.*)$/.exec(auth)!;
  expect(match[2]).toBe(pub.toString("base64url"));
  const [header, payload, signature] = match[1].split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
    aud: "https://web.push.apple.com",
    exp: 44200,
    sub: "https://mac.example.ts.net:8443",
  });
  const key = createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
    },
  });
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
});
test("subscriptions reject private URLs, redirects disguised as providers, and invalid curve keys", () => {
  expect(subscription(target)).toEqual(target);
  for (const endpoint of [
    "http://web.push.apple.com/token",
    "https://localhost/push",
    "https://100.1.2.3/push",
    "https://web.push.apple.com.evil.test/push",
    "https://web.push.apple.com:8443/token",
    "https://user@web.push.apple.com/token",
    "https://fcm.googleapis.com/token#secret",
  ])
    expect(() => subscription({ ...target, endpoint })).toThrow("InvalidSubscription");
  for (const keys of [
    { ...target.keys, p256dh: "x".repeat(87) },
    { ...target.keys, auth: "short" },
  ])
    expect(() => subscription({ ...target, keys })).toThrow("InvalidSubscription");
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  expect(
    subscription({ ...target, keys: { ...target.keys, p256dh: curve.getPublicKey().toString("base64url") } }).keys
      .p256dh,
  ).toHaveLength(87);
});
test("delivery encrypts its body, uses outbound VAPID, and never follows endpoint redirects", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        expect(init?.headers).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: "300" });
        expect(Buffer.from(init!.body as Uint8Array).toString()).not.toContain("private name");
        return new Response(null, { status: 201 });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    expect(await send(target, generateKey(), "https://mac.example.ts.net:8443", { body: "private name" })).toBe(201);
  } finally {
    fetcher.mockRestore();
  }
});
