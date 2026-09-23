import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Copy, LogOut, Monitor, Plus, RefreshCw, Search } from "lucide-react";
import { callAdmin, configured, supabase } from "./api.js";
import { copyText, endOfDayIso, fmtDate, statusOf } from "./format.js";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMade(null);
    try {
      const res = await callAdmin("create", { email, ...(expires ? { expires_at: endOfDayIso(expires) } : {}) });
      setMade({ code: res.code, email: res.license.email });
      setEmail("");
      setExpires("");
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
          <p className="muted">Send the customer this code together with their email. It only works for that email, and binds to the first PC that activates it.</p>
        </div>
      ) : null}
    </section>
  );
}

function Licenses({ refreshKey, onChanged, notify }) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null); // { kind: "revoke" | "release", license }
  const [busy, setBusy] = useState(false);
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
      await callAdmin(confirm.kind, { id: confirm.license.id });
      notify(confirm.kind === "revoke" ? "License revoked" : "PC released");
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
          <thead><tr><th>Customer email</th><th>Access code</th><th>Status</th><th>Activated PC</th><th>Created</th><th /></tr></thead>
          <tbody>
            {items.map((l) => {
              const st = statusOf(l);
              return (
                <tr key={l.id}>
                  <td data-label="Customer" className="email">{l.email}</td>
                  <td data-label="Access code" className="mono">{l.code}</td>
                  <td data-label="Status"><span className={`badge ${st.key}`}>{st.label}</span></td>
                  <td data-label="Activated PC">{l.activated ? <span title={l.device_id_short}><Monitor size={14} aria-hidden="true" /> {l.device_label || l.device_id_short}<br /><small className="muted">{fmtDate(l.activated_at)}</small></span> : "—"}</td>
                  <td data-label="Created">{fmtDate(l.created_at)}</td>
                  <td className="actions"><div className="acts">
                    <button className="btn" onClick={async () => notify((await copyText(l.code)) ? "Access code copied" : "Copy failed")}><Copy size={14} /> Copy</button>
                    {l.activated && l.status !== "revoked" ? <button className="btn" onClick={() => setConfirm({ kind: "release", license: l })}>Release PC</button> : null}
                    {l.status !== "revoked" ? <button className="btn danger" onClick={() => setConfirm({ kind: "revoke", license: l })}><Ban size={14} /> Revoke</button> : null}
                  </div></td>
                </tr>
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
      {confirm?.kind === "release" ? (
        <Confirm title="Release this PC?" confirmLabel="Release PC" busy={busy} onCancel={() => setConfirm(null)} onConfirm={run}>
          <p>Customer: <b>{confirm.license.email}</b><br />PC: <b>{confirm.license.device_label || confirm.license.device_id_short}</b></p>
          <p className="muted">The license becomes unbound. The customer can then activate it on a replacement PC. The current PC will stop working.</p>
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
