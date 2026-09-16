import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import LiveTournamentPage from "./publicLive/LiveTournamentPage.jsx";
import { parsePublicLiveRoute } from "./publicLive/route.js";
import "@tournament/ui/styles.css";
import "./styles.css";

// Checked here, before App ever mounts, rather than as one more branch
// inside App() (the way the existing #/live, #/bracket, #/matches-display
// hash routes are) — App()'s session-restore/offline-outbox effects run
// unconditionally the instant it mounts, and a signed-out spectator should
// never pay that cost. Under Electron (file:// loading), pathname can never
// match /live/..., so this is naturally a no-op there.
const publicRoute = typeof window !== "undefined" ? parsePublicLiveRoute(window.location.pathname) : null;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {publicRoute ? <LiveTournamentPage slugOrId={publicRoute.slugOrId} /> : <App />}
  </StrictMode>,
);
