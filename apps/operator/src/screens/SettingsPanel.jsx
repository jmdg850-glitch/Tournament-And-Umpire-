import { useState } from "react";
import { Button, Card, Input, SectionHeader } from "@tournament/ui";

export function SettingsPanel({ t, busy, run }) {
  const [name, setName] = useState(t.name);
  const dirty = name.trim() !== t.name;
  return (
    <div className="stack">
      <SectionHeader title="Settings" description="Update the tournament name and other tournament-level details." />
      <Card as="form" className="stack" onSubmit={(e) => { e.preventDefault(); run("Save settings", "update_tournament", { tournament_id: t.id, name }); }}>
        <Input label="Tournament name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Button type="submit" disabled={!!busy || !dirty}>Save changes</Button>
      </Card>
    </div>
  );
}
