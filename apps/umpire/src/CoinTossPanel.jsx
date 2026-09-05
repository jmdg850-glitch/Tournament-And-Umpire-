import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@tournament/ui";
import {
  coinFaceFromByte,
  isCoinTossCommitted,
  normalizeCoinTossPayload,
  readCoinToss,
} from "@tournament/engine";

const SPIN_MS = 2200;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Coin({ face, spinning }) {
  const landed = face === "tails" ? "coin-land-tails" : "coin-land-heads";
  const spin = spinning ? (face === "tails" ? "spin-tails" : "spin-heads") : landed;
  return (
    <div className="coin-scene" aria-hidden="true">
      <div className={`coin ${spin}`}>
        <div className="coin-face coin-heads">H</div>
        <div className="coin-face coin-tails">T</div>
      </div>
    </div>
  );
}

export default function CoinTossPanel({
  match,
  nameA,
  nameB,
  busy,
  lastSeq,
  onCommit,
}) {
  const committed = readCoinToss(match);
  const lockRef = useRef(false);
  const [spinning, setSpinning] = useState(false);
  const [pending, setPending] = useState(false);
  const [shown, setShown] = useState(committed);

  useEffect(() => {
    if (committed && !spinning) setShown(committed);
  }, [committed, spinning]);

  async function flip() {
    if (lockRef.current || busy || spinning || isCoinTossCommitted(match)) return;
    lockRef.current = true;
    setPending(true);
    const face = coinFaceFromByte(crypto.getRandomValues(new Uint8Array(1))[0]);
    const proposed = normalizeCoinTossPayload({ result: face, servingTeam: face === "heads" ? "A" : "B" });
    try {
      const result = await onCommit({
        match_id: match.id,
        event_id: crypto.randomUUID(),
        seq: lastSeq + 1,
        result: proposed.result,
        winner: proposed.winner,
        serving_team: proposed.servingTeam,
      });
      const official = readCoinToss(result?.match || { coin_toss: result?.coin_toss }) || proposed;
      setShown(official);
      if (prefersReducedMotion()) {
        setSpinning(false);
        return;
      }
      setSpinning(true);
      await new Promise((resolve) => setTimeout(resolve, SPIN_MS));
      setSpinning(false);
    } catch {
      setSpinning(false);
    } finally {
      setPending(false);
      lockRef.current = false;
    }
  }

  const display = shown || committed;
  const winnerName = display?.winner === "B" ? nameB : nameA;
  const faceLabel = display?.result === "tails" ? "TAILS" : "HEADS";

  return (
    <Card className="ump-toss">
      <div className="kicker">Coin toss</div>
      <h2>Call it</h2>
      <div className="coin-call-row">
        <div className="coin-call">
          <strong>HEADS</strong>
          <span>{nameA}</span>
        </div>
        <div className="coin-call">
          <strong>TAILS</strong>
          <span>{nameB}</span>
        </div>
      </div>

      {!display && (
        <Button className="tape cta" disabled={busy || spinning || pending} onClick={flip}>
          {pending ? "Flipping…" : "Flip coin"}
        </Button>
      )}

      {display && (
        <>
          <Coin face={display.result} spinning={spinning} />
          <p className="coin-flip-label">{spinning ? "COIN FLIP" : faceLabel}</p>
          {!spinning && (
            <div className="coin-result" aria-live="polite">
              <div className="coin-face-word">{faceLabel}</div>
              <div className="coin-winner-name">{winnerName}</div>
              <div className="coin-winner-kicker">WON TOSS</div>
              <p className="coin-award">RECEIVES SERVE</p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
