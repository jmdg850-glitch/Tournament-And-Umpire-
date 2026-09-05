import { useEffect, useState } from "react";
import { Button } from "@tournament/ui";

const desktop = typeof window !== "undefined" ? window.tournamentDesktop : null;

export function useDesktopUpdateContext({ liveMatches = 0, busy = false, dialogOpen = false, enabled = true }) {
  useEffect(() => {
    if (!enabled) return undefined;
    desktop?.updates?.setContext?.({ liveMatches, busy, dialogOpen });
    return undefined;
  }, [enabled, liveMatches, busy, dialogOpen]);
}

export default function UpdateBanner() {
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!desktop?.updates) return undefined;
    desktop.updates.getState?.().then((s) => setState(s)).catch(() => {});
    return desktop.updates.onStatus?.((next) => setState(next));
  }, []);

  if (!desktop?.updates || !state) return null;
  if (!["available", "downloading", "ready"].includes(state.status)) return null;

  const title =
    state.status === "ready"
      ? (state.unsafeToAutoRestart ? "Update ready. Restart when convenient." : "Update ready")
      : state.status === "downloading"
        ? "Downloading update…"
        : "Update available";

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-copy">
        <strong>{title}</strong>
        <span>
          {state.availableVersion
            ? `Version ${state.availableVersion} (you have ${state.currentVersion})`
            : `You have ${state.currentVersion}`}
        </span>
        {state.status === "downloading" ? (
          <progress max="100" value={Math.round(state.percent || 0)} />
        ) : null}
        {state.status === "ready" && state.unsafeToAutoRestart ? (
          <span>Live matches or Live windows are open. Restart will close them.</span>
        ) : null}
      </div>
      <div className="update-banner-actions">
        {state.status === "ready" ? (
          <Button onClick={() => desktop.updates.install()}>Restart &amp; Update</Button>
        ) : null}
        <Button variant="secondary" onClick={() => desktop.updates.later()}>Later</Button>
      </div>
    </div>
  );
}
