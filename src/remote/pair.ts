import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import encodeQR from "qr";
import { field, str } from "../json";
import type { Addresses } from "./tailscale";

export const remoteProtocol = 2;
export type Control = (command: string, value?: Record<string, unknown>) => Promise<unknown>;
export function qr(url: string) {
  const pixels = encodeQR(url, "raw", { border: 4, ecc: "medium" });
  const lines: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    let line = "";
    for (let x = 0; x < pixels.length; x++)
      line += pixels[y][x] ? (pixels[y + 1]?.[x] ? "█" : "▀") : pixels[y + 1]?.[x] ? "▄" : " ";
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join("\n") + "\n";
}
export function links(url: string, addresses: Addresses) {
  const fragment = new URL(url).hash;
  return {
    dns: url,
    ipv4: addresses.ipv4 ? addresses.ipv4 + fragment : null,
    ipv6: addresses.ipv6 ? addresses.ipv6 + fragment : null,
  };
}
/** One owner renews the offer while this command lives; a dead CLI loses its lease. */
export async function run(control: Control, addresses: Addresses) {
  const controller = new AbortController(),
    { signal } = controller;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  let id: string | null = null,
    failure: unknown;
  const stop = () => controller.abort();
  reader.on("SIGINT", stop);
  reader.on("close", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  const heartbeat = setInterval(() => {
    const current = id;
    if (current)
      void control("pair.renew", { id: current }).catch(error => {
        if (id === current && !signal.aborted) {
          failure = error;
          stop();
        }
      });
  }, 10_000);
  try {
    while (!signal.aborted) {
      id = null;
      const offer = await control("pair");
      id = str(offer, "id");
      if (!id) throw Error("Remote service needs updating. Run corgi remote start, then pair again.");
      if (signal.aborted) break;
      const url = str(offer, "url"),
        addressesForOffer = links(url, addresses);
      process.stdout.write(
        `\nConnect your phone to Tailscale, then scan this QR code.\n${qr(url)}MagicDNS: ${addressesForOffer.dns}\nIPv4:     ${addressesForOffer.ipv4 ?? "unavailable"}\nIPv6:     ${addressesForOffer.ipv6 ?? "unavailable"}\nIP links redirect to HTTPS. Pairing stays open until Ctrl+C.\nWaiting for your phone…\n`,
      );
      while (!signal.aborted) {
        const pending = field(await control("pending"), "pending");
        if (pending) {
          const code = str(pending, "code");
          const answer = await reader.question(
            `Phone ${JSON.stringify(str(pending, "name"))}. If its code is ${code}, type ${code} to approve (anything else denies): `,
            { signal },
          );
          await control("approve", { claim: str(pending, "claim"), code, allow: answer.trim() === code });
          process.stdout.write(
            answer.trim() === code
              ? "Phone paired. Waiting for another phone; Ctrl+C to finish.\n"
              : "Pairing denied.\n",
          );
          break;
        }
        await sleep(1000, undefined, { signal });
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    clearInterval(heartbeat);
    if (id) await control("pair.close", { id }).catch(() => {});
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    reader.close();
  }
  if (failure) throw failure;
}
