import type { Conversation, Identity, Launch, Snapshot, Terminal } from "./types";
import type { Management } from "../../types";
import type { Prompt } from "../../types";
import type { Profile } from "../../types";
import type { Command } from "../../types";
export interface Device {
  device: string;
  keys: CryptoKeyPair;
}
export const base64 = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
let token = "",
  loginPending: Promise<void> | undefined;
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function stored(value?: Device | null): Promise<Device | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("corgi-remote", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("device");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("device", value === undefined ? "readonly" : "readwrite"),
        store = tx.objectStore("device"),
        request =
          value === undefined ? store.get("identity") : value ? store.put(value, "identity") : store.delete("identity");
      tx.oncomplete = () => resolve(request.result as Device | undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal, authenticated = true): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) token = "";
    throw new RequestError(response.status, result.error || "Unavailable");
  }
  return result as T;
}
export const unbase64 = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
async function login(verify = false) {
  const identity = await stored();
  if (!identity) throw new RequestError(401, "Pair this phone");
  const { nonce, credential } = await request<{ nonce: string; credential?: string }>(
    "/api/challenge",
    { device: identity.device },
    undefined,
    false,
  );
  let assertion;
  if (credential) {
    if (!verify) throw new RequestError(423, "Unlock this phone");
    const result = (await navigator.credentials.get({
      publicKey: {
        challenge: unbase64(nonce),
        rpId: location.hostname,
        allowCredentials: [{ id: unbase64(credential), type: "public-key" }],
        userVerification: "required",
        timeout: 60000,
      },
    })) as PublicKeyCredential | null;
    if (!result) throw Error("Verification cancelled");
    const response = result.response as AuthenticatorAssertionResponse;
    assertion = {
      clientDataJSON: base64(response.clientDataJSON),
      authenticatorData: base64(response.authenticatorData),
      signature: base64(response.signature),
    };
  }
  const signature = base64(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.keys.privateKey,
      new TextEncoder().encode(`corgi-remote-session\0${location.origin}\0${nonce}`),
    ),
  );
  token = (await request<{ token: string }>("/api/session", { nonce, signature, assertion }, undefined, false)).token;
}
export async function unlockPhone() {
  await login(true);
}
export function forgetToken() {
  token = "";
}
export interface Me {
  id: string;
  name: string;
  role: "reader" | "controller";
  locked: boolean;
}
export async function authenticated<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!token) {
    loginPending ??= login().finally(() => {
      loginPending = undefined;
    });
    await loginPending;
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return request<T>(path, body, signal);
}
export interface Client {
  list(signal: AbortSignal): Promise<Snapshot>;
  conversation(
    id: number,
    identity: Identity,
    cursor: string,
    direction: "before" | "after",
    signal: AbortSignal,
  ): Promise<Conversation>;
  terminal(id: number, identity: Identity, signal: AbortSignal): Promise<Terminal>;
  history(id: number, identity: Identity, signal: AbortSignal, lines?: number): Promise<{ text: string }>;
  send(id: number, body: Identity & { text?: string; enter?: boolean; key?: string }): Promise<void>;
  create(body: Launch): Promise<{ pane: number } & Identity>;
  manage?(body: Management): Promise<void>;
  profiles?(signal: AbortSignal): Promise<Profile[]>;
  prompt?(id: number, identity: Identity, signal: AbortSignal): Promise<Prompt | null>;
  respond?(id: number, identity: Identity, prompt: string, choice: number): Promise<void>;
  events?(signal: AbortSignal, changed: (type: string, data?: Snapshot) => void): Promise<void>;
  me?(signal: AbortSignal): Promise<Me>;
  archive?(id: number, identity: Identity, cursor: string, signal: AbortSignal): Promise<Conversation>;
  speech?(id: number, identity: Identity, signal: AbortSignal): Promise<Blob>;
  commands?(id: number, identity: Identity, signal: AbortSignal): Promise<Command[]>;
}
const params = (identity: Identity) =>
  new URLSearchParams({
    server: String(identity.server),
    binding: identity.binding,
    conversation: identity.conversation,
  });
export const client: Client = {
  commands: (id, identity, signal) => authenticated(`/api/panes/${id}/commands?${params(identity)}`, undefined, signal),
  archive: (id, identity, cursor, signal) =>
    authenticated(
      `/api/panes/${id}/archive?${params(identity)}&cursor=${encodeURIComponent(cursor)}`,
      undefined,
      signal,
    ),
  speech: async (id, identity, signal) => {
    if (!token) await authenticated("/api/me", undefined, signal);
    const response = await fetch(`/api/panes/${id}/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(identity),
      signal,
      cache: "no-store",
    });
    if (!response.ok)
      throw new RequestError(response.status, "Audio unavailable. Check the Mac connection and try again.");
    return response.blob();
  },
  me: signal => authenticated("/api/me", undefined, signal),
  manage: body => authenticated("/api/manage", body),
  profiles: signal => authenticated("/api/profiles", undefined, signal),
  prompt: (id, identity, signal) => authenticated(`/api/panes/${id}/prompt?${params(identity)}`, undefined, signal),
  respond: (id, identity, prompt, choice) => authenticated(`/api/panes/${id}/respond`, { identity, prompt, choice }),
  events: async (signal, changed) => {
    if (!token) await authenticated("/api/me", undefined, signal);
    const response = await fetch("/api/events", {
      headers: { Authorization: `Bearer ${token}` },
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) token = "";
      throw new RequestError(response.status, "Disconnected");
    }
    const reader = response.body!.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 4 * 1024 * 1024) throw Error("InvalidEvent");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const event = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (event.type === "session" || event.type === "activity") {
            const data = event.data;
            if (
              data &&
              (typeof data.server !== "number" || !Array.isArray(data.panes) || !Array.isArray(data.workspaces))
            )
              throw Error("InvalidEvent");
            changed(event.type, data);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },
  list: signal => authenticated("/api/session", undefined, signal),
  conversation: (id, identity, cursor, direction, signal) => {
    const q = params(identity);
    q.set("cursor", cursor);
    q.set("direction", direction);
    return authenticated(`/api/panes/${id}/conversation?${q}`, undefined, signal);
  },
  terminal: (id, identity, signal) => authenticated(`/api/panes/${id}/terminal?${params(identity)}`, undefined, signal),
  history: (id, identity, signal, lines = 300) =>
    authenticated(`/api/panes/${id}/output?${params(identity)}&lines=${lines}`, undefined, signal),
  send: (id, body) => authenticated(`/api/panes/${id}/input`, body),
  create: body => authenticated("/api/agents", body),
};
export async function claim(pair: string, name: string) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const key = base64(await crypto.subtle.exportKey("spki", keys.publicKey));
  const offer = await request<{ claim: string; code: string }>(
    "/api/pair",
    { token: pair, name, key },
    undefined,
    false,
  );
  return { ...offer, keys };
}
export async function finishPair(claim: string, keys: CryptoKeyPair) {
  const outcome = await request<{ state: string; device?: string }>("/api/pair/status", { claim }, undefined, false);
  if (outcome.state === "denied") throw Error("Pairing denied. Run corgi remote pair again for a fresh link.");
  if (outcome.state === "approved" && outcome.device) {
    await stored({ keys, device: outcome.device });
    token = "";
    return true;
  }
  return false;
}
