import { useState } from "react";
import { Button, Card, Checkbox, Input, SectionHeader } from "@tournament/ui";
import { liveShareUrl } from "../lib.js";
import { UrlQr } from "../urlQr.jsx";

export function SettingsPanel({ t, busy, run }) {
  const [name, setName] = useState(t.name);
  const dirty = name.trim() !== t.name;
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  // A spectator link only makes sense in a real browser at a real origin —
  // window.location.origin under Electron's file:// load isn't shareable, so
  // the copy-link/QR controls are hidden there rather than showing a broken
  // or guessed URL (see publicLive/route.js for the /live/<slug> route this
  // links to).
  const httpOrigin = typeof window !== "undefined" && /^https?:$/.test(window.location.protocol);
  const shareUrl = httpOrigin && t.slug ? liveShareUrl(window.location.origin, t.slug) : null;

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
        {t.is_public && t.slug ? (
          httpOrigin ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <Input label="Share link" value={shareUrl} readOnly onFocus={(e) => e.target.select()} />
                <Button variant="secondary" type="button" onClick={copyLink}>{copied ? "Copied!" : "Copy link"}</Button>
                <Button variant="secondary" type="button" onClick={() => setShowQr((v) => !v)}>{showQr ? "Hide QR" : "Show QR"}</Button>
              </div>
              {showQr ? <UrlQr url={shareUrl} /> : null}
            </div>
          ) : (
            <p className="muted">Open the Tournament Operator website (not the desktop app) to copy the shareable link or QR code.</p>
          )
        ) : null}
      </Card>
    </div>
  );
}
