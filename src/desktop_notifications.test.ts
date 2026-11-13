import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Notifications } from "./desktop_notifications";
import * as i18n from "./i18n";

test("native notification clicks resolve only known tokens and are consumed once", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-notify-")),
    helper = join(root, "helper"),
    clicked = Promise.withResolvers<unknown>(),
    seen: unknown[] = [];
  writeFileSync(
    helper,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ready:true}));
createInterface({input:process.stdin}).on('line', async line => {
  const {id} = JSON.parse(line);
  await Bun.write(${JSON.stringify(join(root, "message"))}, line);
  for (const token of ['unknown',id,id]) console.log(JSON.stringify({clicked:token}));
});`,
    { mode: 0o700 },
  );
  const notifications = new Notifications(target => {
    seen.push(target);
    clicked.resolve(target);
  }, helper);
  const prior = process.env.CORGI_BELL;
  delete process.env.CORGI_BELL;
  try {
    await notifications.show("finished", { conversation: 7 }, "Fix notifications", "Changes are ready");
    expect(await clicked.promise).toEqual({ conversation: 7 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(seen).toEqual([{ conversation: 7 }]);
    expect(JSON.parse(readFileSync(join(root, "message"), "utf8"))).toMatchObject({
      title: "Fix notifications",
      subtitle: "Finished",
      body: "Changes are ready",
    });
  } finally {
    notifications.close();
    if (prior === undefined) delete process.env.CORGI_BELL;
    else process.env.CORGI_BELL = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
test("unavailable native notifications fall back to the host terminal and honor mute", async () => {
  const notifications = new Notifications(() => {
      throw Error("UnexpectedClick");
    }, "/nonexistent-corgi-notifier"),
    output = spyOn(process.stdout, "write").mockReturnValue(true),
    prior = process.env.CORGI_BELL,
    language = i18n.language();
  try {
    i18n.setLanguage("en");
    delete process.env.CORGI_BELL;
    await notifications.show("needs_input", { conversation: 1 });
    expect(output.mock.calls.map(args => args[0])).toEqual(["\x1b]777;notify;Corgi;Needs input\x1b\\"]);
    output.mockClear();
    await notifications.show("finished", { conversation: 1 }, "Conversation; title", "Latest\nmessage\x1b");
    expect(output.mock.calls.map(args => args[0])).toEqual([
      "\x1b]777;notify;Conversation  title;Latest message \x1b\\",
    ]);
    output.mockClear();
    process.env.CORGI_BELL = "off";
    await notifications.show("finished", { conversation: 1 });
    expect(output).not.toHaveBeenCalled();
  } finally {
    notifications.close();
    output.mockRestore();
    i18n.setLanguage(language);
    if (prior === undefined) delete process.env.CORGI_BELL;
    else process.env.CORGI_BELL = prior;
  }
});

test("Mac banners can be disabled independently of alert sounds", async () => {
  const notifications = new Notifications(() => {}, "/nonexistent-corgi-notifier"),
    output = spyOn(process.stdout, "write").mockReturnValue(true),
    prior = process.env.CORGI_NOTIFICATIONS;
  try {
    process.env.CORGI_NOTIFICATIONS = "off";
    await notifications.show("needs_input", { conversation: 1 });
    await notifications.show("finished", { conversation: 1 });
    expect(output).not.toHaveBeenCalled();
  } finally {
    notifications.close();
    output.mockRestore();
    if (prior === undefined) delete process.env.CORGI_NOTIFICATIONS;
    else process.env.CORGI_NOTIFICATIONS = prior;
  }
});
