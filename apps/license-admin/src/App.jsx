import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Ban, ChevronDown, ChevronUp, Copy, LogOut, Monitor, Plus, RefreshCw, Search } from "lucide-react";
import { callAdmin, configured, supabase } from "./api.js";
import {
  DEVICE_LIMIT_HINT, DEVICE_LIMIT_MAX, DEVICE_LIMIT_MIN, copyText, endOfDayIso, fmtDate, parseDeviceLimit, statusOf,
} from "./format.js";

function Login() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    setOk("");
    if (mode === "reset") {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
      if (error) setMsg("Unable to send the reset email. Please try again."); else setOk("If that account exists, a reset link is on its way.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setMsg("Invalid email or password.");
    }
    setBusy(false);
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="brand"><span className="ball" aria-hidden="true" /><b>License Admin</b></div>
        <h1>{mode === "reset" ? "Reset password" : "Seller sign-in"}</h1>
        {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
        {ok ? <div className="alert good" role="status">{ok}</div> : null}
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        {mode === "login" ? (
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        ) : null}
        <button className="cta" disabled={busy}>{busy ? "Please wait…" : mode === "reset" ? "Send reset link" : "Sign in"}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === "reset" ? "login" : "reset"); setMsg(""); setOk(""); }}>
          {mode === "reset" ? "Back to sign-in" : "Forgot password?"}
        </button>
      </form>
    </div>
  );
}

function Recovery({ onDone }) {
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  async function submit(e) {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setMsg("Could not update the password. Use at least 8 characters."); else onDone();
  }
  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Choose a new password</h1>
        {msg ? <div className="alert bad" role="alert">{msg}</div> : null}
        <label>New password<input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <button className="cta">Save password</button>
      </form>
    </div>
  );
}

function Confirm({ title, children, confirmLabel, busy, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div className="row end">
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn danger" onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Generate({ onCreated, notify }) {
  const [email, setEmail] = useState("");
  const [expires, setExpires] = useState("");
  const [devices, setDevices] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setMade(null);
    const max = parseDeviceLimit(devices);
    if (max === null) {
      setError(DEVICE_LIMIT_HINT);
      return;
    }
    setBusy(true);
    try {
      const res = await callAdmin("create", { email, max_devices: max, ...(expires ? { expires_at: endOfDayIso(expires) } : {}) });
      setMade({ code: res.code, email: res.license.email, max: res.license.max_devices ?? max });
      setEmail("");
      setExpires("");
      setDevices("1");
      onCreated();
    } catch (err) {
      setError(err.code === "GENERATION_FAILED" ? "LICENSE GENERATION FAILED" : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Generate access code</h2>
      <form className="row gen" onSubmit={submit}>
        <label className="grow">Customer email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" required />
        </label>
        <label>Expires (optional)
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} min={new Date().toISOString().slice(0, 10)} />
        </label>
        <label className="devices-input">Allowed devices
          <input type="number" inputMode="numeric" min={DEVICE_LIMIT_MIN} max={DEVICE_LIMIT_MAX} step={1} value={devices} onChange={(e) => setDevices(e.target.value)} required />
        </label>
        <button className="cta" disabled={busy}><Plus size={18} /> {busy ? "Generating…" : "Generate"}</button>
      </form>
      {error ? <div className="alert bad" role="alert">{error}</div> : null}
      {made ? (
        <div className="made" role="status">
          <div className="muted">ACCESS CODE for <b>{made.email}</b></div>
          <div className="code" data-testid="access-code">{made.code}</div>
          <button className="cta" onClick={async () => notify((await copyText(made.code)) ? "Access code copied" : "Copy failed - select the code manually")}>
            <Copy size={18} /> Copy code
          </button>
          <p className="muted">Send the customer this code together with their email. It only works for that email, on up to {made.max} {made.max === 1 ? "PC" : "PCs"}.</p>
        </div>
      ) : null}
    </section>
  );
}

// Registered devices of one license, plus its editable device limit. The server
// enforces the limit when a device activates; lowering it never releases a
// device, it only stops NEW devices until usage is below the limit.
function DeviceDetails({ license, onRelease, onChanged, notify }) {
  const max = license.max_devices ?? 1;
  const devices = license.devices || [];
  const active = devices.filter((d) => !d.released_at);
  const released = devices.filter((d) => d.released_at);
  const [limit, setLimit] = useState(String(max));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const revoked = license.status === "revoked";
  const wanted = parseDeviceLimit(limit);

  async function save(e) {
    e.preventDefault();
    setError("");
    if (wanted === null) {
      setError(DEVICE_LIMIT_HINT);
      return;
    }
    setSaving(true);
    try {
      await callAdmin("set_max_devices", { id: license.id, max_devices: wanted });
      notify("Device limit saved");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const row = (d) => (
    <li key={d.id} className={d.released_at ? "released" : undefined}>
      <span className="dev-name" title={d.device_id_short || undefined}><Monitor size={14} aria-hidden="true" /> {d.label || d.device_id_short || "Unnamed PC"}</span>
      <small className="muted">First activated {fmtDate(d.first_activated_at)} · Last seen {fmtDate(d.last_seen_at, "never")}</small>
      {d.released_at ? <small className="muted">Released {fmtDate(d.released_at)}</small>
        : !revoked ? <button className="btn" onClick={() => onRelease(d)}>Release</button> : null}
    </li>
  );

  return (
    <div className="device-details">
      <p className="muted" style={{ margin: 0 }}>{active.length} of {max} {max === 1 ? "device" : "devices"} in use.</p>
      {license.over_limit ? (
        <div className="alert warn" role="status">More devices are registered than the current limit. They keep working, but no new PC can activate until fewer than {max} are in use.</div>
      ) : null}
      {active.length === 0 ? <p className="muted">No devices registered yet.</p> : <ul className="device-list">{active.map(row)}</ul>}
      {released.length ? (
        <details><summary className="muted">Released devices ({released.length})</summary><ul className="device-list">{released.map(row)}</ul></details>
      ) : null}
      {!revoked ? (
        <form className="row limit" onSubmit={save}>
          <label>Allowed devices
            <input type="number" inputMode="numeric" min={DEVICE_LIMIT_MIN} max={DEVICE_LIMIT_MAX} step={1} value={limit}
              onChange={(e) => setLimit(e.target.value)} aria-label={`Allowed devices for ${license.email}`} />
          </label>
          <button className="btn" disabled={saving || wanted === max}>{saving ? "Saving…" : "Save"}</button>
          {wanted !== null && wanted < active.length ? (
            <small className="muted">Lowering below {active.length} keeps the current devices; no new PC can activate until usage is below {wanted}.</small>
          ) : null}
        </form>
      ) : null}
      {error ? <div className="alert bad" role="alert">{error}</div> : null}
    </div>
  );
}

function Licenses({ refreshKey, onChanged, notify }) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null); // { kind: "revoke" | "release_device", license, device? }
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); // id of the license whose devices are shown
  const [refreshing, setRefreshing] = useState(false);
  // Only the newest list request may update the table, whether it came from
  // typing, a create/revoke/release, or the Refresh button.
  const latestRequest = useRef(0);
  const refreshInFlight = useRef(false);

  const fetchList = useCallback((term) => {
    const id = ++latestRequest.current;
    return callAdmin("list", { search: term })
      .then((d) => { if (id === latestRequest.current) { setItems(d.items); setError(""); } })
      .catch((e) => { if (id === latestRequest.current) setError(e.message); });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { fetchList(search); }, search ? 250 : 0);
    return () => { clearTimeout(t); latestRequest.current++; };
  }, [search, refreshKey, fetchList]);

  // Manual refresh: a fresh request to the license backend (not a re-render of
  // cached rows). Keeps the current search and the rows on screen until the
  // new data arrives; ignores clicks while a refresh is already running.
  async function refresh() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      await fetchList(search);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }

  // Android hardware back button: close an open confirm dialog instead of
  // exiting the app. No-op on Web/Electron (no native Capacitor runtime there).
  useEffect(() => {
    if (!window.Capacitor?.isNativePlatform?.()) return undefined;
    let handle;
    let cancelled = false;
    import("@capacitor/app").then(({ App: CapApp }) => {
      if (cancelled) return;
      CapApp.addListener("backButton", () => {
        if (confirm) setConfirm(null);
        else CapApp.exitApp();
      }).then((h) => { handle = h; });
    });
    return () => { cancelled = true; handle?.remove(); };
  }, [confirm]);

  async function run() {
    setBusy(true);
    try {
      if (confirm.kind === "release_device") {
        await callAdmin("release_device", { license_id: confirm.license.id, device_id: confirm.device.id });
      } else {
        await callAdmin("revoke", { id: confirm.license.id });
      }
      notify(confirm.kind === "revoke" ? "License revoked" : "Device released");
      setConfirm(null);
      onChanged();
    } catch (err) {
      setError(err.message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="row between">
        <h2>Licenses{items ? ` (${items.length})` : ""}</h2>
        <div className="list-tools">
          <label className="search"><Search size={16} aria-hidden="true" />
            <input type="search" placeholder="Search email, code or PC" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search licenses" />
          </label>
          <button type="button" className="btn refresh" onClick={refresh} disabled={refreshing} aria-busy={refreshing}>
            <RefreshCw size={14} aria-hidden="true" className={refreshing ? "spin" : undefined} /> {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      {error ? <div className="alert bad" role="alert">{error}</div> : null}
      {!items ? <p className="muted">Loading…</p> : items.length === 0 ? <p className="muted">No licenses yet. Generate one above.</p> : (
        <table>
          <thead><tr><th>Customer email</th><th>Access code</th><th>Status</th><th>Devices</th><th>Created</th><th /></tr></thead>
          <tbody>
            {items.map((l) => {
              const st = statusOf(l);
              const max = l.max_devices ?? 1;
              const used = l.active_devices ?? (l.activated ? 1 : 0);
              const over = l.over_limit ?? used > max;
              const isOpen = open === l.id;
              return (
                <Fragment key={l.id}>
                  <tr>
                    <td data-label="Customer" className="email">{l.email}</td>
                    <td data-label="Access code" className="mono">{l.code}</td>
                    <td data-label="Status"><span className={`badge ${st.key}`}>{st.label}</span></td>
                    <td data-label="Devices">
                      <span className="usage" data-testid={`usage-${l.id}`}><Monitor size={14} aria-hidden="true" /> {used} / {max} {max === 1 ? "device" : "devices"}</span>
                      {over ? <> <span className="badge over" title="More devices are registered than the current limit. No new PC can activate until usage is below the limit.">Over limit</span></> : null}
                    </td>
                    <td data-label="Created">{fmtDate(l.created_at)}</td>
                    <td className="actions"><div className="acts">
                      <button className="btn" onClick={async () => notify((await copyText(l.code)) ? "Access code copied" : "Copy failed")}><Copy size={14} /> Copy</button>
                      <button className="btn" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : l.id)}>
                        {isOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />} Devices
                      </button>
                      {l.status !== "revoked" ? <button className="btn danger" onClick={() => setConfirm({ kind: "revoke", license: l })}><Ban size={14} /> Revoke</button> : null}
                    </div></td>
                  </tr>
                  {isOpen ? (
                    <tr className="details">
                      <td colSpan={6}>
                        <DeviceDetails license={l} onRelease={(device) => setConfirm({ kind: "release_device", license: l, device })} onChanged={onChanged} notify={notify} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {confirm?.kind === "revoke" ? (
        <Confirm title="Revoke license?" confirmLabel="Revoke license" busy={busy} onCancel={() => setConfirm(null)} onConfirm={run}>
          <p>Customer: <b>{confirm.license.email}</b><br />Code: <b className="mono">{confirm.license.code}</b></p>
          <p className="muted">The customer will no longer be able to use Tournament Operator with this license.</p>
        </Confirm>
      ) : null}
      {confirm?.kind === "release_device" ? (
        <Confirm title="Release this device?" confirmLabel="Release device" busy={busy} onCancel={() => setConfirm(null)} onConfirm={run}>
          <p>Customer: <b>{confirm.license.email}</b><br />Device: <b>{confirm.device.label || confirm.device.device_id_short}</b></p>
          <p className="muted">This PC stops working with the license and frees one device slot. The customer's other devices keep working.</p>
        </Confirm>
      ) : null}
    </section>
  );
}

// Desktop (Electron) only: a downloaded update also installs on its own when
// the app quits, so this is just a shortcut to restart now.
function UpdateNotice() {
  const updates = typeof window !== "undefined" ? window.licenseAdminDesktop?.updates : undefined;
  const [update, setUpdate] = useState(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!updates) return undefined;
    let live = true;
    updates.getState().then((s) => live && setUpdate(s)).catch(() => {});
    const off = updates.onStatus((s) => live && setUpdate(s));
    return () => { live = false; off?.(); };
  }, [updates]);

  if (!updates || update?.status !== "ready") return null;

  async function restart() {
    setRestarting(true);
    const res = await updates.install().catch(() => ({ ok: false }));
    if (!res?.ok) setRestarting(false);
  }

  return (
    <div className="update-notice" role="status">
      <span>Update {update.availableVersion ? `v${update.availableVersion} ` : ""}ready</span>
      <button className="btn" onClick={restart} disabled={restarting}>{restarting ? "Restarting…" : "Restart"}</button>
      <button className="link" onClick={() => updates.later().then(setUpdate).catch(() => {})}>Later</button>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [recovering, setRecovering] = useState(false);
  const [gate, setGate] = useState("checking"); // checking | ok | denied | error
  const [gateMsg, setGateMsg] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState("");
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const notify = useCallback((m) => { setToast(m); setTimeout(() => setToast(""), 2200); }, []);

  useEffect(() => {
    if (!configured) return undefined;
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s ?? null);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      if (event === "SIGNED_OUT") setRecovering(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Admin status is decided by the server for every session; the client only reacts.
  const userId = session?.user?.id;
  useEffect(() => {
    if (!userId) { setGate("checking"); return undefined; }
    let live = true;
    setGate("checking");
    callAdmin("whoami")
      .then(() => live && setGate("ok"))
      .catch((err) => {
        if (!live) return;
        if (err.code === "FORBIDDEN") setGate("denied"); else { setGateMsg(err.message); setGate("error"); }
      });
    return () => { live = false; };
  }, [userId]);

  const signOut = () => supabase.auth.signOut({ scope: "local" });

  if (!configured) return <div className="center"><div className="card"><h2>Not configured</h2><p>VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are missing from this build.</p></div></div>;
  if (session === undefined) return <div className="center"><span className="ball" aria-hidden="true" /></div>;
  if (recovering && session) return <Recovery onDone={() => setRecovering(false)} />;
  if (!session) return <Login />;
  if (gate === "checking") return <div className="center"><span className="ball" aria-hidden="true" /></div>;
  if (gate !== "ok") {
    return (
      <div className="center">
        <div className="card login">
          <h2>{gate === "denied" ? "Access denied" : "Something went wrong"}</h2>
          <p>{gate === "denied" ? "This account is not authorized to use License Admin." : gateMsg}</p>
          <button className="btn" onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header>
        <div className="brand"><span className="ball" aria-hidden="true" /><b>License Admin</b></div>
        <div className="row">
          <UpdateNotice />
          <span className="muted who">{session.user.email}</span>
          <button className="btn" onClick={signOut}><LogOut size={14} /> Sign out</button>
        </div>
      </header>
      <main>
        <Generate onCreated={bump} notify={notify} />
        <Licenses refreshKey={refreshKey} onChanged={bump} notify={notify} />
      </main>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}

// Named exports exist only so tests can render each piece directly; App's own
// behavior is unchanged (still the sole default export used by main.jsx).
export { Login, Recovery, Confirm, Generate, Licenses, UpdateNotice };
