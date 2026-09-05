import qrcode from "./vendor/qrcode-generator.js";
import { pairingQrText } from "./lib.js";

export function PairingQr({ payload }) {
  const text = pairingQrText(payload);
  let svg = "";
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    svg = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt: "Court pairing QR code" });
  } catch (err) {
    return <p className="muted">QR unavailable: {err.message}. Use Copy pairing code.</p>;
  }
  return (
    // QR codes need true white for scan contrast regardless of theme — intentional exception, not a token.
    <div
      aria-label="Court pairing QR code"
      style={{ width: 280, height: 280, background: "#fff", padding: 8, borderRadius: "var(--radius-lg)" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
