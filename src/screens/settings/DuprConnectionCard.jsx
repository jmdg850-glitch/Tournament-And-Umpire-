import { useEffect, useRef, useState } from "react";
import { Chip } from "../../components/ui/Chip.jsx";
import { RatingPill } from "../../components/ui/RatingPill.jsx";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { Dupr } from "../../lib/dupr.js";
import { D } from "../../theme/tokens.js";

// Connect / unlink / change the CURRENT USER's own DUPR account, via the real
// DUPR "Login with DUPR" iframe flow (dupr.gitbook.io/dupr-raas ->
// integration-checklist/sso-login) — an embedded iframe the user logs into
// DUPR inside, which postMessages {userToken, refreshToken, id, duprId,
// stats} back to us on success. There is no email-lookup endpoint in the
// real DUPR API, so this iframe is the only real way to self-link. Shared
// between the standalone Settings > DUPR screen (DuprPanel.jsx) and the
// Profile screen's DUPR section (MyProfilePanel.jsx) — one implementation,
// two places it's shown. For linking a guest/manual roster row that has no
// PickleLive account, see the "DUPR ID" section in
// src/modals/PlayerEditPanel.jsx instead (name search).
export function DuprConnectionCard({ notify }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null); // {duprId,duprStatus,duprFullName,duprLinkedAt,duprSinglesRating,duprDoublesRating} | null | undefined
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showConnect, setShowConnect] = useState(false); // user tapped Connect/Continue — reveal the login iframe
  const [iframeSrc, setIframeSrc] = useState(null);
  const loginHostRef = useRef(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [confirmChangeAccount, setConfirmChangeAccount] = useState(false);

  const refresh = async () => {
    setLoading(true);
    const s = await Dupr.myStatus();
    setStatus(s);
    setLoading(false);
  };
  useEffect(() => {
    let alive = true;
    Dupr.myStatus().then(s => { if (alive) { setStatus(s); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const linked = status && status.duprStatus === "linked";

  // Fetch the (public-by-design) iframe config only once the user has asked
  // to connect — never requests it while already linked.
  useEffect(() => {
    if (!showConnect || linked || iframeSrc) return;
    let alive = true;
    Dupr.getSsoConfig().then(cfg => {
      if (!alive) return;
      if (!cfg?.ok) { setErr(cfg?.error || "DUPR login isn't configured yet."); return; }
      loginHostRef.current = cfg.loginHost;
      setIframeSrc(`https://${cfg.loginHost}/login-external-app/${cfg.clientKeyBase64}`);
    });
    return () => { alive = false; };
  }, [showConnect, linked, iframeSrc]);

  // The iframe posts a message on successful login — only accept one whose
  // origin matches the DUPR host we actually embedded, and whose payload
  // looks like the documented shape, before ever calling our own backend.
  useEffect(() => {
    if (!iframeSrc) return;
    const handler = (event) => {
      if (!loginHostRef.current || event.origin !== `https://${loginHostRef.current}`) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !data.duprId || !data.userToken || !data.refreshToken) return;
      setBusy(true); setErr("");
      Dupr.linkSelfSso({ userToken: data.userToken, refreshToken: data.refreshToken, duprId: data.duprId, expiresAt: data.expiresAt })
        .then(res => {
          if (res?.ok) { notify && notify("DUPR account connected ✓"); setIframeSrc(null); setShowConnect(false); refresh(); }
          else setErr(res?.error || "Unable to connect your DUPR account.");
        })
        .finally(() => setBusy(false));
    };
    window.addEventListener("message", handler, false);
    return () => window.removeEventListener("message", handler, false);
  }, [iframeSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  const startConnect = () => { setErr(""); setShowConnect(true); };
  const retryConnect = () => { setErr(""); setIframeSrc(null); };

  const unlink = () => setConfirmUnlink(true);
  const runUnlink = async () => {
    setBusy(true);
    try {
      const res = await Dupr.disconnectSelf();
      if (res?.ok) { notify && notify("DUPR account unlinked"); setShowConnect(false); setIframeSrc(null); refresh(); }
      else notify && notify(res?.error || "Couldn't unlink your DUPR account", "err");
    } finally {
      setBusy(false);
    }
  };

  const changeAccount = () => setConfirmChangeAccount(true);
  const runChangeAccount = async () => {
    setBusy(true); setErr("");
    try {
      const res = await Dupr.disconnectSelf();
      if (!res?.ok) { notify && notify(res?.error || "Couldn't disconnect the current DUPR account", "err"); return; }
      await refresh();
      setShowConnect(true); // immediately offer the login iframe for the new account
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ background: D.surface, border: "1px solid " + D.border, borderRadius: 16, padding: "18px", textAlign: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>🏓</div>
        {loading ? (
          <div style={{ fontSize: 13, color: D.textMuted }}>Checking DUPR status…</div>
        ) : linked ? (
          <>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}><Chip label="Connected" color={D.green} /></div>
            <div style={{ fontWeight: 800, fontSize: 16, color: D.textPrimary, marginBottom: 4 }}>{status.duprFullName || "DUPR Player"}</div>
            <div style={{ fontSize: 11, color: D.textMuted, fontVariantNumeric: "tabular-nums", marginBottom: 12 }}>DUPR ID: {status.duprId}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <div>
                <div style={{ fontSize: 9, color: D.textMuted, fontWeight: 700, letterSpacing: "0.5px", marginBottom: 4 }}>SINGLES</div>
                {status.duprSinglesRating != null ? <RatingPill value={status.duprSinglesRating} type="S" /> : <div style={{ fontSize: 12, color: D.textMuted }}>Not available</div>}
              </div>
              <div>
                <div style={{ fontSize: 9, color: D.textMuted, fontWeight: 700, letterSpacing: "0.5px", marginBottom: 4 }}>DOUBLES</div>
                {status.duprDoublesRating != null ? <RatingPill value={status.duprDoublesRating} type="D" /> : <div style={{ fontSize: 12, color: D.textMuted }}>Not available</div>}
              </div>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}><Chip label="Not connected" color={D.muted} /></div>
            <div style={{ fontWeight: 800, fontSize: 16, color: D.textPrimary, marginBottom: 4 }}>DUPR</div>
            <div style={{ fontSize: 12, color: D.textSecondary }}>Connect your DUPR account to sync your completed matches and official DUPR ratings.</div>
          </>
        )}
      </div>

      {!loading && !linked && !showConnect && (
        <button onClick={startConnect} className="press"
          style={{ width: "100%", padding: "12px", background: D.accent, border: "none", borderRadius: 22, color: D.bg, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          Connect with DUPR
        </button>
      )}

      {!loading && !linked && showConnect && (
        <div style={{ background: D.surface, border: "1px solid " + D.border, borderRadius: 14, padding: 14, marginBottom: 16 }}>
          {err ? (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, color: D.red, marginBottom: 4 }}>Unable to connect your DUPR account.</div>
              <div style={{ fontSize: 12, color: D.textMuted, marginBottom: 12 }}>{err}</div>
              <button onClick={retryConnect} className="press"
                style={{ width: "100%", padding: "11px", background: D.cardEl, border: "1px solid " + D.border, borderRadius: 22, color: D.textSecondary, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                Try Again
              </button>
            </>
          ) : busy ? (
            <div style={{ fontSize: 12, color: D.textMuted, textAlign: "center", padding: "20px 0" }}>Connecting to DUPR…</div>
          ) : iframeSrc ? (
            <iframe title="Login with DUPR" src={iframeSrc}
              style={{ width: "100%", height: 420, border: "none", borderRadius: 10, background: D.cardEl }} />
          ) : (
            <div style={{ fontSize: 12, color: D.textMuted, textAlign: "center", padding: "20px 0" }}>Loading DUPR login…</div>
          )}
        </div>
      )}

      {!loading && linked && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={changeAccount} disabled={busy} className="press"
            style={{ flex: 1, padding: "11px", background: D.cardEl, border: "1px solid " + D.border, borderRadius: 22, color: D.textSecondary, fontWeight: 700, fontSize: 13, cursor: busy ? "default" : "pointer", opacity: busy ? .7 : 1 }}>
            Change Account
          </button>
          <button onClick={unlink} disabled={busy} className="press"
            style={{ flex: 1, padding: "11px", background: D.redBg, border: "1px solid " + D.red, borderRadius: 22, color: D.red, fontWeight: 700, fontSize: 13, cursor: busy ? "default" : "pointer", opacity: busy ? .7 : 1 }}>
            Unlink Account
          </button>
        </div>
      )}

      <div style={{ fontSize: 11, color: D.textMuted, lineHeight: 1.6, marginTop: 16, padding: "0 4px" }}>
        Once connected, you can submit completed matches to DUPR from Match History — DUPR results only update when you (or your organizer) tap "Submit to DUPR" on a match, never automatically unless the organizer explicitly enables auto-submit.
      </div>
      {confirmUnlink && (
        <ConfirmDialog title="Unlink DUPR account?"
          message="Your PickleLive account will no longer be connected to this DUPR account. Future completed matches will not be submitted to this DUPR account."
          confirmLabel="Unlink Account" destructive
          onConfirm={() => { setConfirmUnlink(false); runUnlink(); }}
          onCancel={() => setConfirmUnlink(false)} />
      )}
      {confirmChangeAccount && (
        <ConfirmDialog title="Change DUPR account?"
          message="Your current DUPR account will be disconnected from PickleLive before you connect another DUPR account."
          confirmLabel="Change Account"
          onConfirm={() => { setConfirmChangeAccount(false); runChangeAccount(); }}
          onCancel={() => setConfirmChangeAccount(false)} />
      )}
    </div>
  );
}
