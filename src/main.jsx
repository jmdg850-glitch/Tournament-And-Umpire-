import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/base.css'
import App from './App.jsx'

// The external Live Scoreboard window (Electron only — see electron/main.cjs's
// createScoreboardWindow) loads this same bundle with ?mode=scoreboard in its
// URL. That query param is only ever present because the main process put it
// there, so a plain web/Capacitor load never takes this branch — dynamic
// import() also keeps ScoreboardApp out of every other target's fetched code.
const params = new URLSearchParams(window.location.search)
const isScoreboard = params.get('mode') === 'scoreboard'

if (isScoreboard) {
  // TV/projector display is always dark — not the user's app-wide theme choice.
  document.documentElement.dataset.theme = 'dark'
} else {
  // Apply the saved theme synchronously before first paint (avoids a
  // flash of the wrong theme) — useTheme() in App.jsx takes over from here.
  try {
    const saved = JSON.parse(localStorage.getItem('theme') || '"system"')
    const resolved = saved === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : saved
    document.documentElement.dataset.theme = resolved
  } catch { /* best-effort, safe to ignore */ }
}

// Electron gets a desktop shell (sidebar nav, fluid width) instead of the
// phone-shaped column web/Android use — see [data-platform="electron"] in
// base.css. window.electronAPI only exists inside Electron's preload bridge.
if (typeof window !== 'undefined' && window.electronAPI) {
  document.documentElement.dataset.platform = 'electron'
}

if (isScoreboard) {
  import('./screens/scoreboard/ScoreboardApp.jsx').then(({ ScoreboardApp }) => {
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <ScoreboardApp initialCourtId={params.get('courtId') || null} />
      </StrictMode>,
    )
  })
} else {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
