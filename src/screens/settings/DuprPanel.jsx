import { Panel } from "../../components/ui/Panel.jsx";
import { DuprConnectionCard } from "./DuprConnectionCard.jsx";

// Settings > DUPR entry point — the actual connect/unlink/change-account
// logic lives in DuprConnectionCard.jsx, shared with the Profile screen's
// DUPR section (MyProfilePanel.jsx) so there's one implementation of the
// iframe SSO flow, not two.
export function DuprPanel({ onClose, notify }) {
  return (
    <Panel title="DUPR" sub="Link your account to sync match results" onClose={onClose}>
      <DuprConnectionCard notify={notify} />
    </Panel>
  );
}
