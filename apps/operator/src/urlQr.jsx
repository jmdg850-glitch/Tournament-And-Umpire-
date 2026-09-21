import qrcode from "./vendor/qrcode-generator.js";

// Sibling to pairingQr.jsx, same vendored generator — but encodes a real
// share URL (the public "Live" page link) instead of a JSON pairing payload.
// Exported so SettingsPanel.jsx can reuse it for the "Download QR" action
// without re-deriving the SVG markup.
export function buildQrSvg(text, { alt = "QR code" } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt });
}

export function UrlQr({ url, size = 220 }) {
  let svg = "";
  try {
    svg = buildQrSvg(url, { alt: "Live tournament page QR code" });
  } catch (err) {
    return <p className="muted">QR unavailable: {err.message}. Use Copy link instead.</p>;
  }
  return (
    // QR codes need true white for scan contrast regardless of theme — intentional exception, not a token.
    // `scalable: true` above means the SVG has no fixed width/height, so it
    // stretches to fill this container — resizing is just this style change.
    <div
      aria-label="Live tournament page QR code"
      style={{ width: size, height: size, background: "#fff", padding: 8, borderRadius: "var(--radius-lg)" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
