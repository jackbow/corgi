import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const pairingTTL = 60_000;
export const approvalTTL = 120_000;
export const sessionTTL = 12 * 60 * 60 * 1000;
const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const signed = (origin: string, nonce: string) => `corgi-remote-session\0${origin}\0${nonce}`;
export interface Device {
  id: string;
  name: string;
  key: string;
}
interface Pairing {
  id: string;
  digest: string;
  expires: number;
  claim?: { id: string; code: string; device: Device; expires: number; state: "waiting" | "approved" | "denied" };
}
function publicKey(key: string) {
  if (!/^[A-Za-z0-9_-]{100,200}$/.test(key)) throw Error("InvalidKey");
  try {
    const parsed = createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" });
    if (parsed.asymmetricKeyType === "ec" && parsed.asymmetricKeyDetails?.namedCurve === "prime256v1") return parsed;
  } catch {
    // Invalid DER must fail with the same public error as an unsupported key.
  }
  throw Error("InvalidKey");
}
export class Auth {
  private devices: Device[] = [];
  private pairing: Pairing | null = null;
  private outcomes = new Map<string, { state: "approved" | "denied"; device: string | null; expires: number }>();
  private challenges = new Map<string, { device: string; expires: number }>();
  private sessions = new Map<string, { device: string; expires: number }>();
  constructor(
    private file: string,
    readonly origin: string,
  ) {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !saved ||
      typeof saved !== "object" ||
      !("version" in saved) ||
      saved.version !== 1 ||
      !("devices" in saved) ||
      !Array.isArray(saved.devices)
    )
      throw Error("InvalidDevices");
    this.devices = saved.devices.map((d: unknown) => {
      if (
        !d ||
        typeof d !== "object" ||
        !("id" in d) ||
        typeof d.id !== "string" ||
        !("name" in d) ||
        typeof d.name !== "string" ||
        !("key" in d) ||
        typeof d.key !== "string"
      )
        throw Error("InvalidDevices");
      publicKey(d.key);
      return { id: d.id, name: d.name, key: d.key };
    });
    if (this.devices.length > 16 || new Set(this.devices.map(d => d.id)).size !== this.devices.length)
      throw Error("InvalidDevices");
    chmodSync(file, 0o600);
  }
  private save(devices: Device[]) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${secret()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, devices }) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {}
    }
    this.devices = devices;
  }
  list() {
    return this.devices.map(({ id, name }) => ({ id, name }));
  }
  mint(now = Date.now()) {
    const token = secret();
    const id = secret();
    this.pairing = { id, digest: digest(token), expires: now + pairingTTL };
    return { id, url: `${this.origin}/#pair=${token}`, expires: now + pairingTTL };
  }
  renew(id: string, now = Date.now()) {
    const p = this.pairing;
    if (!p || p.id !== id || now >= p.expires) throw Error("InvalidPairing");
    p.expires = now + pairingTTL;
    if (p.claim?.state === "waiting") p.claim.expires = now + approvalTTL;
  }
  close(id: string) {
    if (this.pairing?.id === id) this.pairing = null;
  }
  claim(token: string, name: string, key: string, now = Date.now()) {
    const p = this.pairing;
    if (!p || p.claim || now >= p.expires || !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(p.digest)))
      throw Error("InvalidPairing");
    if (!name.trim() || name.length > 64 || /\p{Cc}/u.test(name)) throw Error("InvalidName");
    publicKey(key);
    p.claim = {
      id: secret(),
      code: (randomBytes(4).readUInt32BE() % 1_000_000) + "",
      device: { id: secret(), name: name.trim(), key },
      expires: now + approvalTTL,
      state: "waiting",
    };
    return { claim: p.claim.id, code: p.claim.code.padStart(6, "0") };
  }
  pending(now = Date.now()) {
    const c = this.pairing?.claim;
    return c && c.state === "waiting" && now < c.expires
      ? { claim: c.id, name: c.device.name, code: c.code.padStart(6, "0") }
      : null;
  }
  approve(id: string, code: string, allow: boolean, now = Date.now()) {
    const c = this.pairing?.claim;
    if (!c || c.id !== id || c.code.padStart(6, "0") !== code || c.state !== "waiting" || now >= c.expires)
      throw Error("InvalidPairing");
    if (allow) {
      if (this.devices.length >= 16) throw Error("DeviceLimit");
      this.save([...this.devices, c.device]);
    }
    c.state = allow ? "approved" : "denied";
    for (const [id, outcome] of this.outcomes) if (now >= outcome.expires) this.outcomes.delete(id);
    if (this.outcomes.size >= 16) this.outcomes.delete(this.outcomes.keys().next().value!);
    this.outcomes.set(id, { state: c.state, device: allow ? c.device.id : null, expires: now + approvalTTL });
  }
  outcome(id: string, now = Date.now()) {
    const finished = this.outcomes.get(id);
    if (finished && now < finished.expires) return { state: finished.state, device: finished.device };
    const c = this.pairing?.claim;
    if (!c || c.id !== id || now >= c.expires) throw Error("InvalidPairing");
    return { state: c.state, device: c.state === "approved" ? c.device.id : null };
  }
  challenge(device: string, now = Date.now()) {
    for (const [nonce, c] of this.challenges) if (now >= c.expires) this.challenges.delete(nonce);
    if (!this.devices.some(d => d.id === device)) throw Error("Unauthorized");
    const pending = [...this.challenges].filter(([, c]) => c.device === device);
    if (pending.length >= 8) this.challenges.delete(pending[0][0]);
    const nonce = secret();
    this.challenges.set(nonce, { device, expires: now + 60_000 });
    return { nonce };
  }
  login(nonce: string, signature: string, now = Date.now()) {
    const c = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    const d = this.devices.find(d => d.id === c?.device);
    if (
      !c ||
      now >= c.expires ||
      !d ||
      !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
      !verify(
        "sha256",
        Buffer.from(signed(this.origin, nonce)),
        { key: publicKey(d.key), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      )
    )
      throw Error("Unauthorized");
    for (const [key, s] of this.sessions) if (now >= s.expires) this.sessions.delete(key);
    const active = [...this.sessions].filter(([, s]) => s.device === d.id);
    if (active.length >= 8) this.sessions.delete(active[0][0]);
    const token = secret();
    this.sessions.set(digest(token), { device: d.id, expires: now + sessionTTL });
    return { token, expires: now + sessionTTL };
  }
  authenticate(token: string, now = Date.now()) {
    const s = this.sessions.get(digest(token));
    if (!s || now >= s.expires) throw Error("Unauthorized");
    return s.device;
  }
  revoke(id: string) {
    if (!this.devices.some(d => d.id === id)) throw Error("NoDevice");
    this.save(this.devices.filter(d => d.id !== id));
    for (const [key, s] of this.sessions) if (s.device === id) this.sessions.delete(key);
    for (const [key, c] of this.challenges) if (c.device === id) this.challenges.delete(key);
    if (this.pairing?.claim?.device.id === id) this.pairing = null;
    for (const [claim, outcome] of this.outcomes) if (outcome.device === id) this.outcomes.delete(claim);
  }
}
