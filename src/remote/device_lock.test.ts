import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { deviceLock, unlock } from "./device_lock";
test("device verification binds signature, origin, nonce, RP and presence plus verification flags", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    origin = "https://mac.example.ts.net:8443",
    nonce = "nonce";
  const lock = deviceLock({
    id: "credentialcredential",
    key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  });
  const assertion = (changes: Record<string, unknown> = {}, flag = 5) => {
    const client = Buffer.from(JSON.stringify({ type: "webauthn.get", origin, challenge: nonce, ...changes })),
      auth = Buffer.concat([
        createHash("sha256").update("mac.example.ts.net").digest(),
        Buffer.from([flag, 0, 0, 0, 0]),
      ]);
    return {
      clientDataJSON: client.toString("base64url"),
      authenticatorData: auth.toString("base64url"),
      signature: sign(
        "sha256",
        Buffer.concat([auth, createHash("sha256").update(client).digest()]),
        keys.privateKey,
      ).toString("base64url"),
    };
  };
  expect(unlock(lock, assertion(), origin, nonce)).toBe(true);
  for (const value of [
    assertion({ origin: "https://evil.example" }),
    assertion({ challenge: "wrong" }),
    assertion({ crossOrigin: true }),
    assertion({}, 1),
    { ...assertion(), signature: "wrong" },
  ])
    expect(unlock(lock, value, origin, nonce)).toBe(false);
});
