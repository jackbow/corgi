import type { Conversation, Identity, Launch, Snapshot, Terminal } from "./types";
export interface Device {
  device: string;
  keys: CryptoKeyPair;
}
const base64 = (value: ArrayBuffer) =>
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
async function login() {
  const identity = await stored();
  if (!identity) throw new RequestError(401, "Pair this phone");
  const { nonce } = await request<{ nonce: string }>("/api/challenge", { device: identity.device }, undefined, false);
  const signature = base64(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.keys.privateKey,
      new TextEncoder().encode(`corgi-remote-session\0${location.origin}\0${nonce}`),
    ),
  );
  token = (await request<{ token: string }>("/api/session", { nonce, signature }, undefined, false)).token;
}
async function authenticated<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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
  history(id: number, identity: Identity, signal: AbortSignal): Promise<{ text: string }>;
  send(id: number, body: Identity & { text?: string; enter?: boolean; key?: string }): Promise<void>;
  create(body: Launch): Promise<{ pane: number } & Identity>;
}
const params = (identity: Identity) =>
  new URLSearchParams({
    server: String(identity.server),
    binding: identity.binding,
    conversation: identity.conversation,
  });
export const client: Client = {
  list: signal => authenticated("/api/session", undefined, signal),
  conversation: (id, identity, cursor, direction, signal) => {
    const q = params(identity);
    q.set("cursor", cursor);
    q.set("direction", direction);
    return authenticated(`/api/panes/${id}/conversation?${q}`, undefined, signal);
  },
  terminal: (id, identity, signal) => authenticated(`/api/panes/${id}/terminal?${params(identity)}`, undefined, signal),
  history: (id, identity, signal) => authenticated(`/api/panes/${id}/output?${params(identity)}`, undefined, signal),
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
