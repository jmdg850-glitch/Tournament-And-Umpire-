import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@tournament/ui";
import {
  coinFaceFromByte,
  isCoinTossCommitted,
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

// The coin only ever shows HEADS or TAILS — it does not decide who serves.
// After the flip, the umpire asks the actual player/team who won the toss what
// they chose, then records that choice explicitly. No team is ever assumed.
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
  const [localFace, setLocalFace] = useState(null);
  const [firstServer, setFirstServer] = useState("");
  const [courtSide, setCourtSide] = useState("");
  const [confirmError, setConfirmError] = useState("");

  const face = committed?.result || localFace;

  useEffect(() => {
    if (committed) {
      setLocalFace(committed.result);
    }
  }, [committed]);

  function flip() {
    if (lockRef.current || busy || spinning || isCoinTossCommitted(match)) return;
    setLocalFace(coinFaceFromByte(crypto.getRandomValues(new Uint8Array(1))[0]));
    if (prefersReducedMotion()) return;
    setSpinning(true);
    window.setTimeout(() => setSpinning(false), SPIN_MS);
  }

  async function confirm() {
    if (!face) return;
    if (!firstServer) {
      setConfirmError("Please select the first server.");
      return;
    }
    if (!courtSide) {
      setConfirmError("Please select the court side.");
      return;
    }
    setConfirmError("");
    lockRef.current = true;
    setPending(true);
    try {
      await onCommit({
        match_id: match.id,
        event_id: crypto.randomUUID(),
        seq: lastSeq + 1,
        result: face,
        winner: firstServer,
        serving_team: firstServer,
        court_side: courtSide,
      });
    } catch {
      // error already surfaced by the caller; leave choices in place to retry
    } finally {
      setPending(false);
      lockRef.current = false;
    }
  }

  const faceLabel = face === "tails" ? "TAILS" : "HEADS";
  const readyToConfirm = Boolean(face) && Boolean(firstServer) && Boolean(courtSide);

  return (
    <Card className="ump-toss">
      <div className="kicker">Coin toss</div>
      <h2>Flip the coin</h2>

      {!face && (
        <Button className="tape cta" disabled={busy || spinning} onClick={flip}>
          Flip coin
        </Button>
      )}

      {face && spinning && (
        <>
          <Coin face={face} spinning={spinning} />
          <p className="coin-flip-label">COIN FLIP</p>
        </>
      )}

      {/* Once the coin lands, the result becomes a small, secondary badge —
          the scoring-relevant decision (who serves first) is what the umpire
          needs to focus on next, not a restated giant HEADS/TAILS. */}
      {face && !spinning && !committed && (
        <div className="coin-result-chip" aria-live="polite">
          <span className="coin-result-chip-icon" aria-hidden="true">🪙</span>
          <span className="coin-result-chip-label">{faceLabel}</span>
        </div>
      )}

      {face && !spinning && !committed && (
        <div className="ump-toss-setup stack">
          <p className="muted" style={{ margin: 0 }}>Select who serves first</p>
          <div>
            <div className="section-label">First server</div>
            <div className="ump-choice-row">
              <button
                type="button"
                className={`ump-choice ${firstServer === "A" ? "selected" : ""}`}
                aria-pressed={firstServer === "A"}
                onClick={() => { setFirstServer("A"); setConfirmError(""); }}
              >
                {nameA}
              </button>
              <button
                type="button"
                className={`ump-choice ${firstServer === "B" ? "selected" : ""}`}
                aria-pressed={firstServer === "B"}
                onClick={() => { setFirstServer("B"); setConfirmError(""); }}
              >
                {nameB}
              </button>
            </div>
          </div>
          <div>
            <div className="section-label">Court / side</div>
            <div className="ump-choice-row">
              <button
                type="button"
                className={`ump-choice ${courtSide === "left" ? "selected" : ""}`}
                aria-pressed={courtSide === "left"}
                onClick={() => { setCourtSide("left"); setConfirmError(""); }}
              >
                Left
              </button>
              <button
                type="button"
                className={`ump-choice ${courtSide === "right" ? "selected" : ""}`}
                aria-pressed={courtSide === "right"}
                onClick={() => { setCourtSide("right"); setConfirmError(""); }}
              >
                Right
              </button>
            </div>
          </div>
          {confirmError && <p className="field-error">{confirmError}</p>}
          <Button className="tape cta" disabled={busy || pending || !readyToConfirm} onClick={confirm}>
            {pending ? "Saving…" : "Confirm & Continue"}
          </Button>
        </div>
      )}

      {committed && (
        <div className="coin-result" aria-live="polite">
          <div className="coin-winner-name">{committed.servingTeam === "B" ? nameB : nameA}</div>
          <div className="coin-winner-kicker">FIRST SERVER</div>
          {committed.courtSide && <p className="coin-award">{committed.courtSide === "left" ? "Left" : "Right"} side</p>}
        </div>
      )}
    </Card>
  );
}
