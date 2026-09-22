import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, SplashScreen } from "@tournament/ui";
import AuthLayout from "./AuthLayout.jsx";
import { RECHECK_MS, callLicense, forgetActive, offlineAllowed, rememberActive } from "./license.js";
import { getOperatorDevice } from "./licenseDevice.js";

// After login: is this account's license activated on THIS PC? The server
// decides. Password reset never touches licenses (they are keyed by email and PC).
export function useLicense({ commandUrl, publishableKey, session }) {
  const userId = session?.user?.id ?? null;
  const token = session?.access_token ?? null;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const [state, setState] = useState({ phase: "checking", view: null, error: "" });
  const [busy, setBusy] = useState(false);

  const call = useCallback(async (action, extra = {}) => {
    const device = await getOperatorDevice();
    return callLicense({ commandUrl, publishableKey, accessToken: tokenRef.current, action, body: { device, ...extra } });
  }, [commandUrl, publishableKey]);

  const refresh = useCallback(async () => {
    if (!tokenRef.current || !userId) return;
    try {
      const view = await call("check");
      if (view.status === "active") rememberActive(userId); else forgetActive(userId);
      setState({ phase: view.status === "active" ? "active" : "blocked", view, error: "" });
    } catch (err) {
      if (err.code === "NETWORK" && offlineAllowed(userId)) setState({ phase: "active", view: null, error: "" });
      else setState({ phase: "blocked", view: null, error: err.message });
    }
  }, [call, userId]);

  useEffect(() => {
    if (!userId) return undefined;
    setState({ phase: "checking", view: null, error: "" });
    refresh();
    const timer = setInterval(refresh, RECHECK_MS);
    window.addEventListener("online", refresh);
    return () => { clearInterval(timer); window.removeEventListener("online", refresh); };
  }, [userId, refresh]);

  const activate = useCallback(async (code) => {
    setBusy(true);
    try {
      const view = await call("activate", { code });
      rememberActive(userId);
      setState({ phase: "active", view, error: "" });
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setBusy(false);
    }
  }, [call, userId]);

  return { ...state, busy, refresh, activate };
}

const INTRO = {
  none: "No license is linked to this email yet. Enter the Access Code you received for this email address.",
  unused: "Enter the Access Code you received for this email address to activate Tournament Operator on this PC.",
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
  if (license.phase === "checking") return <SplashScreen tagline="Operator Desk" status="Checking your license…" />;
  if (license.phase !== "active") return <ActivationScreen license={license} email={email} onSignOut={onSignOut} />;
  return children;
}
