import { EmptyState } from "@tournament/ui";
import { DivisionBracketCard } from "../brackets.jsx";

// Reuses DivisionBracketCard directly — the same read-only bracket renderer
// already shared by the authenticated Brackets tab and BracketWindow.jsx.
// Never a second copy of bracket logic here.
export default function PublicBracketTab({ data }) {
  if (!data.divisions.length) {
    return <EmptyState title="No divisions yet" />;
  }
  return (
    <div className="stack">
      {data.divisions.map((d) => (
        <DivisionBracketCard key={d.id} division={d} data={data} />
      ))}
    </div>
  );
}
