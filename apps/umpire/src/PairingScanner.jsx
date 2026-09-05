import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@tournament/ui";

export default function PairingScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  const [error, setError] = useState("");
  onDetectedRef.current = onDetected;

  useEffect(() => {
    let stopped = false;
    let raf = 0;

    async function start() {
      try {
        if (typeof BarcodeDetector !== "function") {
          setError("QR scanning is not available on this device. Enter the pairing code instead.");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const detector = new BarcodeDetector({ formats: ["qr_code"] });

        async function tick() {
          if (stopped) return;
          const video = videoRef.current;
          if (video && video.readyState >= 2) {
            try {
              const codes = await detector.detect(video);
              const raw = codes?.[0]?.rawValue;
              if (raw) {
                onDetectedRef.current(raw);
                return;
              }
            } catch {
              /* keep scanning */
            }
          }
          raf = requestAnimationFrame(tick);
        }
        raf = requestAnimationFrame(tick);
      } catch (err) {
        setError(err.message || "Camera unavailable. Enter the pairing code instead.");
      }
    }

    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <Card className="stack ump-scanner" style={{ marginTop: 12 }}>
      <h2>Scan QR code</h2>
      <p className="muted">Point the camera at the organizer pairing QR. This reads the same short-lived pairing grant.</p>
      {error ? <p className="muted">{error}</p> : (
        <video ref={videoRef} className="ump-scanner-video" playsInline muted autoPlay />
      )}
      <Button variant="secondary" type="button" onClick={onClose}>Cancel scan</Button>
    </Card>
  );
}
