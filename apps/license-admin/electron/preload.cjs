const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("licenseAdminDesktop", {
  runtime: "electron",
  getInfo: () => ipcRenderer.invoke("desktop-info"),
  updates: {
    getState: () => ipcRenderer.invoke("updater:get-state"),
    install: () => ipcRenderer.invoke("updater:install"),
    later: () => ipcRenderer.invoke("updater:later"),
    onStatus: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("updater:status", handler);
      return () => ipcRenderer.removeListener("updater:status", handler);
    },
  },
});
