import { Badge, Button, Card, EmptyState } from "@tournament/ui";
import { computeAttentionItems } from "./attention.js";

export default function AttentionPanel({ tournaments, matches, courtDevices, pendingSync, onOpen }) {
  const items = computeAttentionItems({ tournaments, matches, courtDevices });

  if (items.length === 0 && !pendingSync) {
    return (
      <Card className="stack">
        <h2>Attention needed</h2>
        <EmptyState title="Nothing needs your attention right now">
          Live matches, held matches, and court pairing problems will show up here.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card className="stack">
      <h2>Attention needed</h2>
      <div className="stack" style={{ gap: 10 }}>
        {items.map((item) => (
          <div key={item.tournamentId} className="row attention-item" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <strong>{item.tournamentName}</strong>
              {item.live > 0 && <Badge tone="live">{item.live} live</Badge>}
              {item.held > 0 && <Badge tone="warn">{item.held} on hold</Badge>}
              {item.courtsNeedRepairing > 0 && (
                <Badge tone="warn">{item.courtsNeedRepairing} court{item.courtsNeedRepairing === 1 ? "" : "s"} need re-pairing</Badge>
              )}
            </div>
            <Button
              variant="secondary"
              onClick={() => onOpen(item.tournamentId, item.live || item.held ? "matches" : "courts")}
            >
              Open
            </Button>
          </div>
        ))}
        {pendingSync > 0 && (
          <p className="muted" style={{ margin: 0 }}>
            {pendingSync} of your own {pendingSync === 1 ? "action is" : "actions are"} waiting to sync — will send when back online.
          </p>
        )}
      </div>
    </Card>
  );
}
