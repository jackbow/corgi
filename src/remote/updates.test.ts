import { expect, test } from "bun:test";
import { Updates } from "./updates";

test("phone updates reject unmanaged installs and stale runtimes", async () => {
  const unmanaged = new Updates(
    async () => ({ server: 42, executable: "/feature/corgi" }),
    "socket",
    async () => ({ code: 1, text: "unmanaged" }),
  );
  expect((await unmanaged.status()).phase).toBe("unsupported");
  await expect(unmanaged.start(42)).rejects.toThrow("Unsupported");
  const managed = new Updates(
    async () => ({ server: 42, executable: "/release/corgi" }),
    "socket",
    async () => ({ code: 0, text: "current: 1.0.0" }),
  );
  await expect(managed.start(41)).rejects.toThrow("PaneChanged");
});

test("confirmed updates run once with fixed arguments and report deferred restart without leaking output", async () => {
  let finish!: (v: { code: number; text: string }) => void;
  const commands: string[][] = [];
  const updater = new Updates(
    async () => ({ server: 42, executable: "/release/corgi" }),
    "socket",
    async (exe, args) => {
      commands.push([exe, ...args]);
      return args.length
        ? { code: 0, text: "current: 1.0.0\nstaged: 1.1.0\nprivate path" }
        : new Promise(resolve => {
            finish = resolve;
          });
    },
  );
  expect((await updater.start(42)).phase).toBe("running");
  await expect(updater.start(42)).rejects.toThrow("RateLimited");
  expect(commands).toEqual([["/release/corgi", "status"], ["/release/corgi"]]);
  finish({ code: 1, text: "UpdateDeferred /private/path" });
  await Bun.sleep(0);
  expect((await updater.status()).phase).toBe("deferred");
  expect(JSON.stringify(await updater.status())).not.toContain("/private");
});

test("failed update jobs retain uncertainty and successful jobs permit fresh runtime status", async () => {
  let server = 42;
  const updater = new Updates(
    async () => ({ server, executable: "/release/corgi" }),
    "socket",
    async (_exe, args) => {
      if (!args.length) throw Error("private failure");
      return { code: 0, text: "current: 1.0.0" };
    },
  );
  await updater.start(42);
  await Bun.sleep(0);
  expect((await updater.status()).phase).toBe("failed");
  server++;
  expect((await updater.status()).server).toBe(43);
});
