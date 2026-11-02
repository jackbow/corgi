/* Device keys stay in this origin's IndexedDB; session tokens stay in memory. */
"use strict";
const el = id => document.getElementById(id);
const status = message => {
  el("status").textContent = message;
};
const base64 = value =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
let token = "",
  identity,
  session,
  selected = null,
  busy = false,
  polling = false,
  rendered = "";
const db = new Promise((resolve, reject) => {
  const request = indexedDB.open("corgi-remote", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("device");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function stored(value, write = false) {
  const database = await db;
  return new Promise((resolve, reject) => {
    const tx = database.transaction("device", write ? "readwrite" : "readonly"),
      store = tx.objectStore("device");
    const request = write ? (value ? store.put(value, "identity") : store.delete("identity")) : store.get("identity");
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function api(path, body, authenticated = true) {
  const headers = {};
  if (authenticated) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return result;
}
async function login() {
  const { nonce } = await api("/api/challenge", { device: identity.device }, false);
  const signature = base64(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.keys.privateKey,
      new TextEncoder().encode(`corgi-remote-session\0${location.origin}\0${nonce}`),
    ),
  );
  token = (await api("/api/session", { nonce, signature }, false)).token;
}
function options(id, items, value) {
  const select = el(id),
    signature = JSON.stringify(items);
  if (select.dataset.items !== signature) {
    select.replaceChildren(
      ...items.map(item => {
        const option = document.createElement("option");
        option.value = String(item.id);
        option.textContent = item.name;
        return option;
      }),
    );
    select.dataset.items = signature;
  }
  select.value = items.some(item => String(item.id) === value) ? value : String(items[0]?.id ?? "");
}
function choose() {
  options("workspace", session.workspaces, el("workspace").value);
  const panes = session.panes.filter(p => p.workspace === Number(el("workspace").value));
  options("pane", panes, el("pane").value);
  const next = panes.find(p => p.id === Number(el("pane").value)) || null;
  if (selected?.id !== next?.id || selected?.binding !== next?.binding || selected?.server !== session.server) {
    rendered = "";
    el("output").textContent = "";
  }
  selected = next ? { ...next, server: session.server } : null;
  el("activity").textContent = selected
    ? [selected.state, selected.activity, selected.exited ? "Exited" : ""].filter(Boolean).join(" · ")
    : "No panes in this workspace";
  controls();
}
function controls() {
  document
    .querySelectorAll("#send button, nav button")
    .forEach(button => (button.disabled = busy || !selected || selected.exited));
}
async function refresh() {
  if (polling || document.hidden || !identity) return;
  polling = true;
  try {
    if (!token) await login();
    session = await api("/api/session");
    choose();
    el("main").hidden = false;
    el("forget").hidden = false;
    if (selected) {
      const pane = selected,
        { text } = await api(`/api/panes/${pane.id}/output`);
      if (selected?.id === pane.id && selected?.binding === pane.binding && text !== rendered) {
        const output = el("output"),
          bottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 32;
        output.textContent = text;
        rendered = text;
        if (bottom) output.scrollTop = output.scrollHeight;
      }
    }
    status("Connected through Tailscale");
  } catch (error) {
    if (error.status === 401) token = "";
    status(
      error.status === 401
        ? "Session expired or phone revoked. Reconnecting; pair again if needed."
        : "Disconnected. Check Tailscale on both devices and that the computer is awake.",
    );
  } finally {
    polling = false;
  }
}
async function send(body) {
  if (busy || !selected || selected.exited) return;
  const pane = { ...selected };
  busy = true;
  controls();
  try {
    await api(`/api/panes/${pane.id}/input`, { server: pane.server, binding: pane.binding, ...body });
    if (body.text !== undefined && el("message").value === body.text) el("message").value = "";
    el("delivery").textContent = "Sent";
  } catch (error) {
    if (error.status === 401) token = "";
    el("delivery").textContent =
      error.message === "PaneChanged"
        ? "Pane changed. Refresh before sending again."
        : "Send was not confirmed. Check the pane before retrying.";
  } finally {
    busy = false;
    controls();
  }
}
el("send").onsubmit = event => {
  event.preventDefault();
  void send({ text: el("message").value, enter: el("enter").checked });
};
document
  .querySelectorAll("[data-key]")
  .forEach(button => (button.onclick = () => void send({ key: button.dataset.key })));
el("workspace").onchange = el("pane").onchange = () => {
  choose();
  void refresh();
};
el("latest").onclick = () => {
  el("output").scrollTop = el("output").scrollHeight;
};
el("forget").onclick = async () => {
  await stored(null, true);
  location.reload();
};
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
window.addEventListener("online", () => void refresh());
async function start() {
  identity = await stored();
  const pair = new URLSearchParams(location.hash.slice(1)).get("pair");
  history.replaceState(null, "", location.pathname);
  if (pair) {
    el("pairing").hidden = false;
    status("Ready to pair. Keep the pairing command open on your computer.");
    el("pair").onsubmit = async event => {
      event.preventDefault();
      const button = el("pair").querySelector("button");
      button.disabled = true;
      try {
        const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        const key = base64(await crypto.subtle.exportKey("spki", keys.publicKey));
        const claim = await api("/api/pair", { token: pair, name: el("name").value, key }, false);
        el("code").textContent = `Confirm code ${claim.code} on your computer.`;
        status("Waiting for approval…");
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const outcome = await api("/api/pair/status", { claim: claim.claim }, false);
          if (outcome.state === "denied") throw new Error("Pairing denied");
          if (outcome.state === "approved") {
            identity = { keys, device: outcome.device };
            token = "";
            await stored(identity, true);
            el("pairing").hidden = true;
            await refresh();
            return;
          }
        }
        throw new Error("Pairing expired");
      } catch (error) {
        status(`${error.message}. Run corgi remote pair again for a fresh link.`);
      }
    };
  } else if (identity) await refresh();
  else status("Run corgi remote pair on your computer, then open its link on this phone.");
  setInterval(() => {
    if (el("pairing").hidden && !busy) void refresh();
  }, 2000);
}
start().catch(error => status(`Could not initialize secure phone storage: ${error.message}`));
