// Device descriptor sent to the license service: { id, label }.
// Desktop: a hashed Windows machine id from the Electron main process (stable
// across reinstalls). Web fallback: a UUID kept in localStorage. The computer
// or browser name is only a label, never the identity.

const WEB_KEY = "tournament.operator.installId";

function webInstallId() {
  try {
    let id = localStorage.getItem(WEB_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(WEB_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// Module-level so its identity is stable for hooks.
export async function getOperatorDevice() {
  const desktop = typeof window !== "undefined" ? window.tournamentDesktop : null;
  if (desktop?.getLicenseDevice) {
    const d = await desktop.getLicenseDevice();
    return { id: d.deviceId, label: d.label || "Windows PC" };
  }
  return { id: `web-${webInstallId()}`, label: "Web browser" };
}
