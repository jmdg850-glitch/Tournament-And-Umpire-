import { useState } from "react";
import { Badge, Button, Card, EmptyState, Input, SectionHeader, Table } from "@tournament/ui";
import { PairingQr } from "../pairingQr.jsx";
import { pairingQrText, sideOf } from "../lib.js";

export function CourtsPanel({ data, busy, run, onOpenLiveWindow }) {
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState(null);
  const liveMatchByCourtId = new Map(
    data.courtAssignments
      .map((a) => [a.court_id, data.matches.find((m) => m.id === a.match_id && m.status === "in_progress")])
      .filter(([, m]) => m)
  );
  async function openPairing(court) {
    const out = await run("Open pairing", "open_court_pairing", { court_id: court.id });
    if (out?.result) setPairing({ court, ...out.result });
  }
  return (
    <div className="stack">
      <SectionHeader title="Courts" description="Add courts, then pair a court-side device by QR to start sending matches to it." />
      <Card as="form" className="row" onSubmit={(e) => {
        e.preventDefault();
        run("Create court", "create_court", { tournament_id: data.tournament.id, name });
        setName("");
      }}>
        <Input label="Court name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Button type="submit" disabled={!!busy}>Add court</Button>
      </Card>
      <p className="muted">Print the court QR once. Open a pairing window when you hand a tablet to that court. New matches on the same court do not need a new QR.</p>
      {pairing && (
        <Card className="stack">
          <h2>Pairing window — {pairing.court?.name || "Court"}</h2>
          <p>Expires {new Date(pairing.expires_at).toLocaleTimeString()}. Scan with Tournament Umpire, or copy the pairing code as a fallback. This grant is one-time and short-lived.</p>
          <PairingQr payload={pairing.pairing_payload} />
          <div className="row">
            <Button
              variant="secondary"
              type="button"
              onClick={async () => {
                const text = pairingQrText(pairing.pairing_payload);
                try {
                  await navigator.clipboard.writeText(text);
                } catch {
                  window.prompt("Copy pairing code", text);
                }
              }}
            >
              Copy pairing code
            </Button>
            <Button variant="secondary" type="button" onClick={() => setPairing(null)}>Hide</Button>
          </div>
        </Card>
      )}
      {data.courts.length === 0 ? (
        <EmptyState title="No courts yet">Add courts before assigning matches.</EmptyState>
      ) : (
        <Table
          responsive
          columns={[
            { key: "name", header: "Court" },
            {
              key: "status",
              header: "Status",
              render: (c) => {
                const liveMatch = liveMatchByCourtId.get(c.id);
                const devices = (data.courtDevices || []).filter((d) => d.court_id === c.id);
                const active = devices.find((d) => d.status === "active");
                const revoked = !active && devices.some((d) => d.status === "revoked");
                // A broken station is the most actionable fact, even if a match happens
                // to be live on this court right now — it wins over "Live".
                if (revoked) return <Badge tone="danger">Needs attention</Badge>;
                if (liveMatch) return <Badge tone="live">Live</Badge>;
                if (active) return <Badge tone="ok">Ready</Badge>;
                return <Badge tone="muted">Unpaired</Badge>;
              },
            },
            {
              key: "match",
              header: "Current match",
              render: (c) => {
                const liveMatch = liveMatchByCourtId.get(c.id);
                if (!liveMatch) return <span className="muted">—</span>;
                const a = sideOf(liveMatch.id, "A", data);
                const b = sideOf(liveMatch.id, "B", data);
                return (
                  <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span>{a.name} vs {b.name}</span>
                    {onOpenLiveWindow && (
                      <Button variant="tape" className="compact" onClick={() => onOpenLiveWindow(liveMatch.id)}>
                        View live
                      </Button>
                    )}
                  </div>
                );
              },
            },
            {
              key: "actions",
              header: "",
              render: (c) => {
                const device = (data.courtDevices || []).find((d) => d.court_id === c.id && d.status === "active");
                return (
                  <div className="row">
                    <Button variant="secondary" disabled={!!busy} onClick={() => openPairing(c)}>Pair device</Button>
                    {device && (
                      <Button variant="secondary" disabled={!!busy} onClick={() => run("Revoke device", "revoke_court_device", { court_id: c.id }, true)}>
                        Revoke
                      </Button>
                    )}
                  </div>
                );
              },
            },
          ]}
          rows={data.courts}
        />
      )}
    </div>
  );
}
