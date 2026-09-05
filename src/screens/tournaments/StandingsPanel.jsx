import { buildTournamentStandings } from "../../lib/tournamentStandings.js";
import { Table, Thead, Tr, Td, RankCell } from "../../components/ui/Table.jsx";
import { D } from "../../theme/tokens.js";

export function StandingsPanel({registrations,matches}){
  const rows=buildTournamentStandings(registrations,matches);
  const nameFor=id=>{
    const r=registrations.find(x=>x.id===id);
    return r ? Object.values(r.playerNames||{}).join(" / ")||"Unnamed" : "—";
  };
  if(!rows.length) return <div style={{textAlign:"center",padding:"30px 20px",color:D.textMuted,fontSize:13}}>No completed matches yet.</div>;
  return(
    <Table>
      <Thead columns={["#","Player / Team","W","L","Games","Pts +/-","Pts Against","Avg Score"]}/>
      <tbody>
        {rows.map(r=>(
          <Tr key={r.registrationId} top={r.rank<=3}>
            <RankCell rank={r.rank}/>
            <Td strong color={D.textPrimary}>{nameFor(r.registrationId)}</Td>
            <Td align="center" strong color={D.green}>{r.wins}</Td>
            <Td align="center" strong color={D.red}>{r.losses}</Td>
            <Td align="center">{r.gamesWon}-{r.gamesLost}</Td>
            <Td align="center" strong color={r.pointDiff>=0?D.green:D.red}>{r.pointDiff>=0?"+":""}{r.pointDiff}</Td>
            <Td align="center">{r.pointsAgainst}</Td>
            <Td align="center">{r.averageScore}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
