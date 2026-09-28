import { Alert, Button } from "@tournament/ui";
import { RefreshCw } from "lucide-react";
import { deriveConnectionState } from "@tournament/client";
import { savedAtLabel } from "./offlineData.js";

// One place that tells the operator whether what they see is server-
// confirmed, saved on this computer, or missing. Renders nothing when the
// data is up to date. Never shows a raw network error.
export default function OfflineStatusBanner({ load, identityMode, onRetry }) {
  const state = deriveConnectionState({ load, identityMode });
  if (state.kind === "online" || (state.kind === "refreshing" && load?.source !== "cache")) return null;
  const when = state.hasData && state.kind !== "auth" && state.kind !== "forbidden" ? savedAtLabel(state.savedAt) : "";
  const tone = state.tone === "danger" ? undefined : state.tone === "info" ? "ok" : "warn";
  return (
    <Alert tone={tone}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span>
          {state.label}
          {when ? <span className="muted"> ({when})</span> : null}
        </span>
        {onRetry && state.kind !== "refreshing" && state.kind !== "offline-unverified" && (
          <Button variant="secondary" className="compact" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </Button>
        )}
      </div>
    </Alert>
  );
}
