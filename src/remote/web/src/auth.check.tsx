import { afterEach, expect, it, vi } from "vitest";
function storage(initial: unknown) {
  let value = initial;
  return {
    open: vi.fn(() => {
      const db = {
        close: () => {},
        transaction: () => {
          const tx = {
            oncomplete: null as (() => void) | null,
            objectStore: () => ({
              get: () => complete(value),
              put: (next: unknown) => {
                value = next;
                return complete(undefined);
              },
              delete: () => {
                value = undefined;
                return complete(undefined);
              },
            }),
          };
          const complete = (result: unknown) => {
            queueMicrotask(() => tx.oncomplete?.());
            return { result };
          };
          return tx;
        },
      };
      const r = { result: db, onsuccess: null as (() => void) | null };
      queueMicrotask(() => r.onsuccess?.());
      return r;
    }),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("uses an existing enrolled key and never replays an uncertain send", async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
    db = storage({ device: "existing-phone", keys });
  vi.stubGlobal("indexedDB", db);
  let sends = 0;
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : null;
    if (path === "/api/challenge") {
      expect(body).toEqual({ device: "existing-phone" });
      return Response.json({ nonce: "nonce" });
    }
    if (path === "/api/session" && init.method === "POST") {
      const signature = Uint8Array.from(atob(body.signature.replaceAll("-", "+").replaceAll("_", "/")), c =>
        c.charCodeAt(0),
      );
      expect(
        await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          keys.publicKey,
          signature,
          new TextEncoder().encode(`corgi-remote-session\0${location.origin}\0nonce`),
        ),
      ).toBe(true);
      return Response.json({ token: "session" });
    }
    if (path.includes("/input")) {
      sends++;
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return Response.json({ server: 42, workspaces: [], panes: [] });
  });
  vi.stubGlobal("fetch", fetch);
  const { client } = await import("./client");
  await client.list(new AbortController().signal);
  await expect(
    client.send(2, { server: 42, binding: "3", conversation: "thread", text: "hello", enter: true }),
  ).rejects.toThrow("Unauthorized");
  expect(sends).toBe(1);
  expect(db.open).toHaveBeenCalledWith("corgi-remote", 1);
  await client.list(new AbortController().signal);
  expect(sends).toBe(1);
});
it("keeps pairing keys in the existing origin store and can forget them", async () => {
  const db = storage(undefined);
  vi.stubGlobal("indexedDB", db);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      Response.json(path === "/api/pair" ? { claim: "claim", code: "123456" } : { state: "approved", device: "phone" }),
    ),
  );
  const { claim, finishPair, stored } = await import("./client");
  const offer = await claim("pair-token", "My phone");
  expect(offer.keys.privateKey.extractable).toBe(false);
  expect(await finishPair(offer.claim, offer.keys)).toBe(true);
  expect((await stored())?.device).toBe("phone");
  await stored(null);
  expect(await stored()).toBeUndefined();
});
