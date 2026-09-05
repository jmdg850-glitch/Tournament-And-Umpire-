const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tournamentDesktop", {
  runtime: "electron",
  authRedirect: "tournament-operator://auth/callback",
  onAuthCallback: (cb) => {
    ipcRenderer.on("auth-callback", (_event, url) => cb(url));
  },
  openLiveWindow: (payload) => ipcRenderer.invoke("open-live-window", {
    tournamentId: payload?.tournamentId,
    matchId: payload?.matchId,
  }),
  updates: {
    getState: () => ipcRenderer.invoke("updater:get-state"),
    check: () => ipcRenderer.invoke("updater:check"),
    install: () => ipcRenderer.invoke("updater:install"),
    later: () => ipcRenderer.invoke("updater:later"),
    setContext: (payload) => ipcRenderer.send("updater:set-context", {
      liveMatches: payload?.liveMatches,
      busy: payload?.busy,
      dialogOpen: payload?.dialogOpen,
    }),
    onStatus: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("updater:status", handler);
      return () => ipcRenderer.removeListener("updater:status", handler);
    },
  },
});
