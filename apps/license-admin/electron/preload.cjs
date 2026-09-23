const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("licenseAdminDesktop", {
  runtime: "electron",
  getInfo: () => ipcRenderer.invoke("desktop-info"),
});
