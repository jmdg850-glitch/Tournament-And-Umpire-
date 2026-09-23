import { useState } from "react";
import { Alert, Button, Input } from "@tournament/ui";
import { claimLicense, rememberHasAccount, setupLicensePassword } from "./license.js";
import { getOperatorDevice } from "./licenseDevice.js";

// Code-first activation for a new buyer:
//   access code → license bound to this PC → create your password → account
//   ready → signed in.
// Every decision (code validity, binding, "already on another PC", whether an
// account may be created) is made by the `license` Edge Function; this screen
// only walks the buyer through it. The password is sent once and never stored.

const STEPS = ["Access code", "Create password", "Ready"];

function Steps({ current }) {
  return (
    <ol className="setup-steps" aria-label="Activation steps">
      {STEPS.map((label, i) => (
        <li key={label} className={i < current ? "done" : i === current ? "current" : undefined} aria-current={i === current ? "step" : undefined}>
          <span className="setup-step-num" aria-hidden="true">{i + 1}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

export function ActivationSetup({ supabase, commandUrl, publishableKey, onSignIn }) {
  const [step, setStep] = useState("code"); // code | password | ready
  const [code, setCode] = useState("");
  const [claimed, setClaimed] = useState(null); // { email, bound }
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState(null); // email that already has an account

  async function submitCode(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setExisting(null);
    try {
      const device = await getOperatorDevice();
      const r = await claimLicense({ commandUrl, publishableKey, code, device });
      if (r.next === "sign_in") {
        setExisting(r.email);
        return;
      }
      setClaimed({ email: r.email, bound: r.bound });
      setStep("password");
    } catch (err) {
      setError(err.message || "Could not verify this access code.");
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(e) {
    e.preventDefault();
    setError("");
    if (password.length < 8 || password.length > 72) {
      setError("Choose a password of 8 to 72 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const device = await getOperatorDevice();
      const r = await setupLicensePassword({ commandUrl, publishableKey, code, device, password });
      setStep("ready");
      rememberHasAccount();
      // Signing in hands off to the normal session → license check flow.
      const { error: err } = await supabase.auth.signInWithPassword({ email: r.email, password });
      if (err) throw Object.assign(new Error("Your account is ready, but automatic sign-in failed. Please sign in."), { code: "SIGN_IN_FAILED" });
    } catch (err) {
      if (err.code === "ACCOUNT_EXISTS") {
        setExisting(claimed?.email || "");
        setStep("code");
      } else if (err.code !== "SIGN_IN_FAILED") {
        setStep("password");
      }
      setError(err.code === "ACCOUNT_EXISTS" ? "" : err.message || "Could not create your password.");
    } finally {
      setBusy(false);
      setPassword("");
      setConfirm("");
    }
  }

  if (existing !== null) {
    return (
      <div className="stack">
        <Steps current={2} />
        <Alert tone="ok">
          This license is active on this PC and already has an account{existing ? ` (${existing})` : ""}. Sign in with that account's password — or use Reset password if you don't know it.
        </Alert>
        <Button type="button" onClick={() => onSignIn(existing || "")}>Continue to sign in</Button>
      </div>
    );
  }

  if (step === "code") {
    return (
      <form className="stack" onSubmit={submitCode}>
        <Steps current={0} />
        <p className="muted setup-copy">Enter the Access Code you received after purchase. It activates Tournament Operator on this PC.</p>
        <Input
          label="Access code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Activate license"}</Button>
      </form>
    );
  }

  if (step === "password") {
    return (
      <form className="stack" onSubmit={submitPassword}>
        <Steps current={1} />
        <Alert tone="ok">
          License {claimed?.bound === "already_here" ? "is bound" : "bound"} to this PC. Now create your own password.
        </Alert>
        <p className="muted setup-copy">
          Your sign-in email is <strong className="setup-email">{claimed?.email}</strong>. You'll use it with this password from now on — no access code needed.
        </p>
        <input type="email" value={claimed?.email || ""} autoComplete="username" readOnly hidden />
        <Input label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} maxLength={72} autoComplete="new-password" hint="8 to 72 characters." />
        <Input label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} maxLength={72} autoComplete="new-password" />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={busy}>{busy ? "Creating account…" : "Create password"}</Button>
      </form>
    );
  }

  return (
    <div className="stack">
      <Steps current={2} />
      <Alert tone="ok">Account ready. {error ? "" : "Signing you in…"}</Alert>
      {error && <Alert>{error}</Alert>}
      {error && <Button type="button" onClick={() => onSignIn(claimed?.email || "")}>Go to sign in</Button>}
    </div>
  );
}
