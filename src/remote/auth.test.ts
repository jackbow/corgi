import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, approvalTTL, pairingTTL, sessionTTL, signed } from "./auth";

const origin = "https://mac.example.ts.net:8443";
export function phone() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    sign: (nonce: string) =>
      sign("sha256", Buffer.from(signed(origin, nonce)), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      ),
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-auth-")),
    file = join(dir, "devices.json");
  const auth = new Auth(file, origin),
    p = phone();
  const claim = (now = 0) => {
    const offer = auth.mint(now),
      token = new URL(offer.url).hash.slice("#pair=".length);
    return auth.claim(token, "Phone", p.key, now);
  };
  const pair = () => {
    const c = claim();
    auth.approve(c.claim, c.code, true, 1);
    return auth.outcome(c.claim, 2).device!;
  };
  return { dir, file, auth, p, claim, pair, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
test("pairing requires local approval, persists only device keys, and revokes sessions", () => {
  const f = fixture();
  try {
    const c = f.claim();
    expect(f.auth.outcome(c.claim, 1)).toEqual({ state: "waiting", device: null });
    expect(() => f.auth.approve(c.claim, "wrong", true, 1)).toThrow("InvalidPairing");
    f.auth.approve(c.claim, c.code, true, 1);
    const device = f.auth.outcome(c.claim, 2).device!;
    const { nonce } = f.auth.challenge(device, 3),
      session = f.auth.login(nonce, f.p.sign(nonce), 4);
    expect(f.auth.authenticate(session.token, 5)).toBe(device);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(f.file, "utf8")).not.toContain(session.token);
    const restored = new Auth(f.file, origin);
    expect(restored.list()).toEqual([{ id: device, name: "Phone" }]);
    expect(() => restored.authenticate(session.token, 5)).toThrow("Unauthorized");
    f.auth.revoke(device);
    expect(() => f.auth.authenticate(session.token, 5)).toThrow("Unauthorized");
    expect(new Auth(f.file, origin).list()).toEqual([]);
  } finally {
    f.dispose();
  }
});
test("pairing tokens rotate, are single use, and expire; denial never enrolls a device", () => {
  const f = fixture();
  try {
    const old = new URL(f.auth.mint(0).url).hash.slice(6);
    const token = new URL(f.auth.mint(1).url).hash.slice(6);
    expect(() => f.auth.claim(old, "Phone", f.p.key, 2)).toThrow("InvalidPairing");
    const c = f.auth.claim(token, "Phone", f.p.key, 2);
    expect(() => f.auth.claim(token, "Phone", f.p.key, 3)).toThrow("InvalidPairing");
    f.auth.approve(c.claim, c.code, false, 4);
    expect(f.auth.outcome(c.claim, 5).state).toBe("denied");
    expect(f.auth.list()).toEqual([]);
    const expired = new URL(f.auth.mint(10).url).hash.slice(6);
    expect(() => f.auth.claim(expired, "Phone", f.p.key, 10 + pairingTTL)).toThrow("InvalidPairing");
    const late = f.claim(20);
    expect(() => f.auth.approve(late.claim, late.code, true, 20 + approvalTTL)).toThrow("InvalidPairing");
    const replaced = f.claim(30);
    f.auth.mint(31);
    expect(() => f.auth.approve(replaced.claim, replaced.code, true, 32)).toThrow("InvalidPairing");
  } finally {
    f.dispose();
  }
});
test("challenges are single use, reject a different phone key, and sessions expire", () => {
  const f = fixture();
  try {
    const device = f.pair(),
      other = phone();
    const bad = f.auth.challenge(device, 10);
    expect(() => f.auth.login(bad.nonce, other.sign(bad.nonce), 11)).toThrow("Unauthorized");
    expect(() => f.auth.login(bad.nonce, f.p.sign(bad.nonce), 11)).toThrow("Unauthorized");
    const expired = f.auth.challenge(device, 20);
    expect(() => f.auth.login(expired.nonce, f.p.sign(expired.nonce), 60_020)).toThrow("Unauthorized");
    const c = f.auth.challenge(device, 30),
      s = f.auth.login(c.nonce, f.p.sign(c.nonce), 31);
    expect(() => f.auth.login(c.nonce, f.p.sign(c.nonce), 32)).toThrow("Unauthorized");
    expect(() => f.auth.authenticate(s.token, 31 + sessionTTL)).toThrow("Unauthorized");
    const pending = f.auth.challenge(device, 50);
    f.auth.revoke(device);
    expect(() => f.auth.login(pending.nonce, f.p.sign(pending.nonce), 51)).toThrow("Unauthorized");
  } finally {
    f.dispose();
  }
});
test("invalid device stores fail closed", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, '{"version":3,"devices":[]}');
    expect(() => new Auth(f.file, origin)).toThrow("InvalidDevices");
    writeFileSync(f.file, "broken json");
    expect(() => new Auth(f.file, origin)).toThrow();
  } finally {
    f.dispose();
  }
});

test("phone tabs may sign in concurrently and session counts stay bounded", () => {
  const f = fixture();
  try {
    const device = f.pair();
    const one = f.auth.challenge(device, 10),
      two = f.auth.challenge(device, 10);
    const first = f.auth.login(one.nonce, f.p.sign(one.nonce), 11);
    const second = f.auth.login(two.nonce, f.p.sign(two.nonce), 11);
    expect(f.auth.authenticate(first.token, 12)).toBe(device);
    expect(f.auth.authenticate(second.token, 12)).toBe(device);
    for (let i = 0; i < 7; i++) {
      const c = f.auth.challenge(device, 20);
      f.auth.login(c.nonce, f.p.sign(c.nonce), 21);
    }
    expect(() => f.auth.authenticate(first.token, 22)).toThrow("Unauthorized");
    expect(f.auth.authenticate(second.token, 22)).toBe(device);
  } finally {
    f.dispose();
  }
});

test("a live command renews the same link and pending approval beyond their original deadlines", () => {
  const f = fixture();
  try {
    const offer = f.auth.mint(0),
      token = new URL(offer.url).hash.slice(6);
    for (let now = 10_000; now <= 180_000; now += 10_000) f.auth.renew(offer.id, now);
    const claim = f.auth.claim(token, "Phone", f.p.key, 180_001);
    for (let now = 190_000; now <= 400_000; now += 10_000) f.auth.renew(offer.id, now);
    f.auth.approve(claim.claim, claim.code, true, 400_001);
    f.auth.mint(400_002);
    expect(f.auth.outcome(claim.claim, 400_003).state).toBe("approved");
  } finally {
    f.dispose();
  }
});
test("closing an owner invalidates its offer; stale owners cannot close or renew a replacement", () => {
  const f = fixture();
  try {
    const old = f.auth.mint(0),
      next = f.auth.mint(1);
    expect(() => f.auth.renew(old.id, 2)).toThrow("InvalidPairing");
    f.auth.close(old.id);
    f.auth.renew(next.id, 2);
    f.auth.close(next.id);
    expect(() => f.auth.claim(new URL(next.url).hash.slice(6), "Phone", f.p.key, 3)).toThrow("InvalidPairing");
    const abandoned = f.auth.mint(10);
    expect(() => f.auth.renew(abandoned.id, 10 + pairingTTL)).toThrow("InvalidPairing");
  } finally {
    f.dispose();
  }
});
