import { useState } from "react";
import { Badge, Button, Card, Checkbox, Input, Modal, SectionHeader } from "@tournament/ui";
import { liveShareUrl, resolveShareOrigin } from "../lib.js";
import { UrlQr, buildQrSvg } from "../urlQr.jsx";

export function SettingsPanel({ t, busy, run }) {
  const [name, setName] = useState(t.name);
  const dirty = name.trim() !== t.name;
  const [showQrModal, setShowQrModal] = useState(false);
  const [copied, setCopied] = useState(false);
  // Works in both the web app (real http(s) origin) and the Electron desktop
  // app (file://, which falls back to the production web origin) — see
  // resolveShareOrigin in lib.js and publicLive/route.js for the /live/<slug>
  // route this links to. The Operator app never needs the separate website
  // just to obtain this link/QR.
  const shareUrl = t.slug ? liveShareUrl(resolveShareOrigin(typeof window !== "undefined" ? window : null), t.slug) : null;

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — the share-link field itself is still selectable/copyable by hand.
    }
  }

  function downloadQr() {
    if (!shareUrl) return;
    try {
      const svg = buildQrSvg(shareUrl, { alt: "Live tournament page QR code" });
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${t.slug}-live-qr.svg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Best-effort — UrlQr already surfaces a "QR unavailable" fallback inline.
    }
  }

  return (
    <div className="stack">
      <SectionHeader title="Settings" description="Update the tournament name and other tournament-level details." />
      <Card as="form" className="stack" onSubmit={(e) => { e.preventDefault(); run("Save settings", "update_tournament", { tournament_id: t.id, name }); }}>
        <Input label="Tournament name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Button type="submit" disabled={!!busy || !dirty}>Save changes</Button>
      </Card>

      <Card className="stack">
        <SectionHeader
          title="Public live page"
          description="Let spectators follow live scores, the bracket, and results with no login — read-only, off by default."
        />
        <label className="row" style={{ gap: 8, alignItems: "center" }}>
          <Checkbox
            checked={!!t.is_public}
            disabled={!!busy}
            onChange={() => run("Update public live page", "update_tournament", { tournament_id: t.id, is_public: !t.is_public })}
          />
          <span>{t.is_public ? "Public — anyone with the link can view" : "Private — not visible to spectators"}</span>
        </label>
        {t.is_public && shareUrl ? (
          <div className="stack" style={{ gap: 10 }}>
            <Badge tone="live">● LIVE</Badge>
            <p className="muted">Share this tournament publicly — scan the QR code or copy the link to view the live tournament.</p>
            <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
              <UrlQr url={shareUrl} size={140} />
              <div className="stack" style={{ gap: 10, flex: "1 1 260px", minWidth: 220 }}>
                <Input label="Share link" value={shareUrl} readOnly onFocus={(e) => e.target.select()} />
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <Button variant="secondary" type="button" onClick={copyLink}>{copied ? "Copied!" : "Copy Link"}</Button>
                  <Button variant="secondary" type="button" onClick={() => setShowQrModal(true)}>Show QR</Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </Card>

      {showQrModal && shareUrl ? (
        <Modal title="Public Live" onClose={() => setShowQrModal(false)}>
          <div className="stack" style={{ gap: 12, alignItems: "center", textAlign: "center" }}>
            <UrlQr url={shareUrl} size={280} />
            <p className="muted">Scan to view the live tournament</p>
            <Input label="Share link" value={shareUrl} readOnly onFocus={(e) => e.target.select()} />
            <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <Button variant="secondary" type="button" onClick={copyLink}>{copied ? "Copied!" : "Copy Link"}</Button>
              <Button variant="secondary" type="button" onClick={downloadQr}>Download QR</Button>
              <Button type="button" onClick={() => setShowQrModal(false)}>Close</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
