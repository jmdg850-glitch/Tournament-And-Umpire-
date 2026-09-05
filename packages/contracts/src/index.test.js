import { parseCommandEnvelope, isUuid, encodePairingPayload, parsePairingPayload, COMMAND_TYPES } from "./index.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("contracts", () => {
  it("accepts a valid envelope", () => {
    const cmd = parseCommandEnvelope({
      command_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "start_match",
      payload: { match_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    });
    assert.equal(cmd.type, "start_match");
    assert.equal(isUuid(cmd.command_id), true);
  });

  it("includes remove_participant without changing the pairing command set", () => {
    assert.equal(COMMAND_TYPES.includes("remove_participant"), true);
    assert.equal(COMMAND_TYPES.includes("open_court_pairing"), true);
  });
});

describe("pairing payload {v,sid,g}", () => {
  it("encodes only the short-lived grant fields", () => {
    const text = encodePairingPayload({
      v: 1,
      sid: "19a43442723a5501b1d3b643ea111a56",
      g: "lNDGNYnvh7Pgde7nfiKk9Bq-Y1qMdpr30wmmQ6oeUts",
      match_id: "should-not-appear",
      organizer: "nope",
    });
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed).sort(), ["g", "sid", "v"]);
    assert.equal(parsed.v, 1);
    assert.equal(parsed.sid, "19a43442723a5501b1d3b643ea111a56");
    assert.equal(parsed.g, "lNDGNYnvh7Pgde7nfiKk9Bq-Y1qMdpr30wmmQ6oeUts");
  });

  it("parses the same payload the pair-station flow already uses", () => {
    const text = encodePairingPayload({
      v: 1,
      sid: "station-public-id",
      g: "one-time-grant",
    });
    const parsed = parsePairingPayload(text);
    assert.equal(parsed.stationPublicId, "station-public-id");
    assert.equal(parsed.pairingToken, "one-time-grant");
  });
});
