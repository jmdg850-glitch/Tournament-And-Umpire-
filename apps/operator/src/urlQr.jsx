import qrcode from "./vendor/qrcode-generator.js";

// Sibling to pairingQr.jsx, same vendored generator — but encodes a real
// share URL (the public "Live" page link) instead of a JSON pairing payload.
export function UrlQr({ url }) {
  let svg = "";
  try {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    svg = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt: "Live tournament page QR code" });
  } catch (err) {
    return <p className="muted">QR unavailable: {err.message}. Use Copy link instead.</p>;
  }
  return (
    // QR codes need true white for scan contrast regardless of theme — intentional exception, not a token.
    <div
      aria-label="Live tournament page QR code"
      style={{ width: 220, height: 220, background: "#fff", padding: 8, borderRadius: "var(--radius-lg)" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
