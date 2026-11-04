import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authenticated, base64, forgetToken, stored, unlockPhone, type Me } from "./client";
import { Button } from "./ui";
import { keepAwake, terminalInterval } from "./playback";
import { MacUpdates } from "./updates";

export function UnlockScreen({ unlocked }: { unlocked?: () => void }) {
  const cache = useQueryClient(),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="enrollment">
      <h1>Corgi is locked</h1>
      <p>Verify with Face ID, Touch ID or your device passcode.</p>
      <Button
        disabled={pending}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          setError("");
          try {
            await unlockPhone();
            unlocked?.();
            void cache.invalidateQueries();
          } catch {
            setError("Verification cancelled or unavailable. Try again.");
          } finally {
            setPending(false);
          }
        }}
      >
        Unlock Corgi
      </Button>
      <p role="status">{error}</p>
    </main>
  );
}
export function DeviceSettings({ me }: { me: Me }) {
  const cache = useQueryClient(),
    [role, setRole] = useState<"reader" | "controller">("reader"),
    [link, setLink] = useState(""),
    [pending, setPending] = useState(false),
    [status, setStatus] = useState(""),
    [awake, setAwake] = useState(keepAwake),
    [revoke, setRevoke] = useState<Me | null>(null);
  const [interval, setInterval] = useState(terminalInterval);
  const version = useQuery({
    queryKey: ["version"],
    queryFn: () => authenticated<{ version: string; commit: string; builtAt: string; reason: string }>("/api/version"),
    retry: false,
  });
  const query = useQuery({
    queryKey: ["devices"],
    enabled: me.role === "controller",
    queryFn: () =>
      authenticated<{ devices: Me[]; pending: { claim: string; name: string; code: string } | null }>("/api/devices"),
    refetchInterval: 2000,
    retry: false,
  });
  const run = async (fn: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setStatus("");
    try {
      await fn();
      void cache.invalidateQueries({ queryKey: ["devices"] });
    } catch {
      setStatus("Action not confirmed. Check the current state before trying again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="control-panel">
      <h2>Devices</h2>
      <p>
        {me.name} · {me.role === "reader" ? "Read only" : "Controller"}
      </p>
      {me.role === "controller" && (
        <>
          {query.data?.devices.map(d => (
            <div className="device-row" key={d.id}>
              <span>
                {d.name} · {d.role === "reader" ? "Read only" : "Controller"}
              </span>
              <Button disabled={pending} onClick={() => setRevoke(d)}>
                Revoke {d.name}
              </Button>
            </div>
          ))}
          {revoke && (
            <div role="alertdialog" aria-label="Revoke device" className="notice">
              <p>Revoke {revoke.name}? It will need to pair again.</p>
              <Button
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await authenticated("/api/devices/revoke", { id: revoke.id });
                    if (revoke.id === me.id) {
                      await stored(null);
                      location.replace("/");
                    }
                    setRevoke(null);
                  })
                }
              >
                Confirm revocation
              </Button>
              <Button onClick={() => setRevoke(null)}>Cancel</Button>
            </div>
          )}
          <label>
            Invite access
            <select value={role} onChange={e => setRole(e.target.value as typeof role)}>
              <option value="reader">Read only</option>
              <option value="controller">Controller</option>
            </select>
          </label>
          <Button
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const offer = await authenticated<{ url: string }>("/api/devices/invite", { role });
                setLink(offer.url);
              })
            }
          >
            Create pairing link
          </Button>
          {link && (
            <label>
              One-use link · expires in one minute
              <input readOnly value={link} onFocus={e => e.currentTarget.select()} />
              <span className="muted">Open or paste it on the new device, then compare the code here.</span>
            </label>
          )}
          {query.data?.pending && (
            <div className="notice">
              <p>{query.data.pending.name} wants to pair. Compare this code on both devices:</p>
              <strong className="pair-code">{query.data.pending.code}</strong>
              {[true, false].map(allow => (
                <Button
                  key={String(allow)}
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      await authenticated("/api/devices/approve", { ...query.data!.pending, allow });
                      setLink("");
                    })
                  }
                >
                  {allow ? "Codes match — approve" : "Deny"}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      <h2>Device verification</h2>
      <p className="muted">Require device verification when signing in. Available on browsers with passkeys.</p>
      <Button
        disabled={pending || !("PublicKeyCredential" in window)}
        onClick={() =>
          void run(async () => {
            if (me.locked) {
              await unlockPhone();
              await authenticated("/api/device/lock", null);
            } else {
              const identity = await stored();
              if (!identity) throw Error("PairFirst");
              const credential = (await navigator.credentials.create({
                publicKey: {
                  challenge: crypto.getRandomValues(new Uint8Array(32)),
                  rp: { name: "Corgi", id: location.hostname },
                  user: { id: new TextEncoder().encode(identity.device), name: me.name, displayName: me.name },
                  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                  authenticatorSelection: {
                    authenticatorAttachment: "platform",
                    userVerification: "required",
                    residentKey: "preferred",
                  },
                  attestation: "none",
                  timeout: 60000,
                },
              })) as PublicKeyCredential | null;
              const response = credential?.response as AuthenticatorAttestationResponse | undefined,
                key = response?.getPublicKey();
              if (!credential || !key) throw Error("VerificationUnavailable");
              await authenticated("/api/device/lock", { id: base64(credential.rawId), key: base64(key) });
            }
            forgetToken();
            void cache.invalidateQueries();
          })
        }
      >
        {me.locked ? "Disable device verification" : "Enable device verification"}
      </Button>
      <h2>Terminal</h2>
      <label className="check-label">
        <input
          type="checkbox"
          checked={awake}
          onChange={e => {
            setAwake(e.target.checked);
            try {
              localStorage.setItem("corgi-keep-awake", e.target.checked ? "on" : "off");
            } catch {}
          }}
        />
        Keep screen awake in Terminal
      </label>
      <label>
        Terminal refresh
        <select
          value={interval}
          onChange={e => {
            const n = Number(e.target.value);
            setInterval(n);
            try {
              localStorage.setItem("corgi-terminal-interval", String(n));
            } catch {}
          }}
        >
          {[250, 500, 1000, 2000, 5000].map(n => (
            <option key={n} value={n}>
              {n < 1000 ? `${n} ms` : `${n / 1000} seconds`}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">Your phone may release the wake lock when hidden or on low battery.</p>
      <h2>Updates</h2>
      {me.role === "controller" && <MacUpdates />}
      <p>{version.data?.version ?? "Checking Mac version…"}</p>
      <p className="muted">{version.data?.reason}</p>
      <Button
        disabled={pending}
        onClick={() =>
          void run(async () => {
            const registration =
              "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
            await registration?.update();
            location.reload();
          })
        }
      >
        Refresh phone app
      </Button>
      <p role="status">{status}</p>
    </section>
  );
}
