import { describe, expect, test } from "vitest";
import { signStationJwt, verifyStationJwt } from "./stationAuth.js";

process.env.STATION_JWT_SECRET ||= "unit-test-station-secret";

describe("station jwt", () => {
  test("signs and verifies a court device token", async () => {
    const token = await signStationJwt({
      deviceId: "11111111-1111-4111-8111-111111111111",
      courtId: "22222222-2222-4222-8222-222222222222",
      tournamentId: "33333333-3333-4333-8333-333333333333",
    });
    const claims = await verifyStationJwt(token);
    expect(claims.typ).toBe("station");
    expect(claims.sub).toBe("11111111-1111-4111-8111-111111111111");
    expect(claims.court_id).toBe("22222222-2222-4222-8222-222222222222");
  });

  test("rejects a tampered token", async () => {
    const token = await signStationJwt({
      deviceId: "11111111-1111-4111-8111-111111111111",
      courtId: "22222222-2222-4222-8222-222222222222",
      tournamentId: "33333333-3333-4333-8333-333333333333",
    });
    const bad = `${token.slice(0, -2)}aa`;
    expect(await verifyStationJwt(bad)).toBeNull();
  });
});
