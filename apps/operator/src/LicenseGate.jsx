import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, SplashScreen } from "@tournament/ui";
import AuthLayout from "./AuthLayout.jsx";
import { callLicense, createLicenseMonitor, offlineLicenseError, rememberActive } from "./license.js";
import { getOperatorDevice } from "./licenseDevice.js";

// After login: is this account's license activated on THIS PC? The server
// decides. Password reset never touches licenses (they are keyed by email and PC).
// `userId` may be given without a session: the offline identity (sign-in not
// verified, no token). Its checks never reach the server — they report
// "unreachable", so only the existing 7-day offline allowance can apply.
export function useLicense({ commandUrl, publishableKey, session, userId: identityUserId = null }) {
  const userId = session?.user?.id ?? identityUserId ?? null;
  const token = session?.access_token ?? null;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const [state, setState] = useState({ phase: "checking", view: null, error: "" });
  const [busy, setBusy] = useState(false);

  const call = useCallback(async (action, extra = {}) => {
    if (!tokenRef.current) throw offlineLicenseError();
    const device = await getOperatorDevice();
    return callLicense({ commandUrl, publishableKey, accessToken: tokenRef.current, action, body: { device, ...extra } });
  }, [commandUrl, publishableKey]);

  const monitorRef = useRef(null);

  useEffect(() => {
    if (!userId) return undefined;
    setState({ phase: "checking", view: null, error: "" });
    const monitor = createLicenseMonitor({ userId, check: () => call("check"), onState: setState });
    monitorRef.current = monitor;
    monitor.start();
    const onOnline = () => { monitor.refresh(); };
    const onFocus = () => { monitor.refreshIfStale(); };
    const onVisible = () => { if (document.visibilityState === "visible") monitor.refreshIfStale(); };
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      monitor.stop();
      if (monitorRef.current === monitor) monitorRef.current = null;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, call]);

  // Offline identity → verified sign-in (same user): check with the server now
  // instead of waiting for the next periodic check.
  const hasToken = Boolean(token);
  const hadTokenRef = useRef(hasToken);
  useEffect(() => {
    if (hasToken && !hadTokenRef.current) monitorRef.current?.refresh();
    hadTokenRef.current = hasToken;
  }, [hasToken]);

  const refresh = useCallback(() => { monitorRef.current?.refresh(); }, []);
  // Called when /command refuses a licensed operation (LICENSE_INVALID/REQUIRED).
  const reportDenial = useCallback(() => { monitorRef.current?.reportDenial(); }, []);

  const activate = useCallback(async (code) => {
    setBusy(true);
    try {
      const view = await call("activate", { code });
      rememberActive(userId);
      if (monitorRef.current) monitorRef.current.set({ phase: "active", view, error: "" });
      else setState({ phase: "active", view, error: "" });
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setBusy(false);
    }
  }, [call, userId]);

  return { ...state, busy, refresh, activate, reportDenial };
}

const INTRO = {
  none: "No license is linked to this email yet. Enter the Access Code you received for this email address.",
  unused: "Enter the Access Code you received for this email address to activate RESETIQ Operator on this PC.",
  // The license is active on other PC(s) but this one isn't registered (new,
  // or released by the admin). Activating uses a free device slot; when the
  // license is full the server answers with its device-limit message.
  not_registered: "This PC isn't activated for your license yet. Enter your Access Code to activate it on this PC.",
};

function ActivationScreen({ license, email, onSignOut }) {
  const [code, setCode] = useState("");
  const status = license.view?.status;
  const blockedMessage = license.view?.message;   // revoked / expired / activated on another PC
  const canEnterCode = !blockedMessage;

  return (
    <AuthLayout
      title={blockedMessage ? "License unavailable" : "Activate license"}
      subtitle={blockedMessage ? null : INTRO[status] || INTRO.none}
    >
      <p className="muted" style={{ margin: "4px 0 12px" }}>Signed in as <strong>{email}</strong></p>
      {blockedMessage ? <Alert tone="warn">{blockedMessage}</Alert> : null}
      {license.error ? <Alert>{license.error}</Alert> : null}
      {canEnterCode ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (code.trim()) license.activate(code); }}>
          <Input
            label="Access Code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <Button type="submit" disabled={license.busy || !code.trim()}>
            {license.busy ? "Activating…" : "Activate license"}
          </Button>
        </form>
      ) : null}
      <div className="row" style={{ marginTop: 12 }}>
        <Button variant="secondary" onClick={license.refresh} disabled={license.busy}>Check again</Button>
        <Button variant="ghost" onClick={onSignOut}>Sign out</Button>
      </div>
    </AuthLayout>
  );
}

export function LicenseGate({ license, email, onSignOut, children }) {
  if (license.phase === "checking") return <SplashScreen continued tagline="Operator Desk" status="Checking your license…" />;
  if (license.phase !== "active") return <ActivationScreen license={license} email={email} onSignOut={onSignOut} />;
  return children;
}
