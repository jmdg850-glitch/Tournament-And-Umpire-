import { describe, expect, test } from "vitest";
import { generateTournamentSlug, candidateSlug } from "./slug.js";

describe("generateTournamentSlug", () => {
  test("kebab-cases a normal name", () => {
    expect(generateTournamentSlug("Summer Open 2026")).toBe("summer-open-2026");
  });

  test("strips punctuation and collapses whitespace", () => {
    expect(generateTournamentSlug("  Riverside Club's  Fall  Classic!! ")).toBe("riverside-club-s-fall-classic");
  });

  test("strips diacritics", () => {
    expect(generateTournamentSlug("Café Résumé Championship")).toBe("cafe-resume-championship");
  });

  test("falls back to 'tournament' for an empty or symbols-only name", () => {
    expect(generateTournamentSlug("")).toBe("tournament");
    expect(generateTournamentSlug("   ")).toBe("tournament");
    expect(generateTournamentSlug("!!!???")).toBe("tournament");
    expect(generateTournamentSlug(null)).toBe("tournament");
    expect(generateTournamentSlug(undefined)).toBe("tournament");
  });

  test("truncates long names at 60 chars without leaving a trailing dash", () => {
    const name = "A".repeat(80);
    const slug = generateTournamentSlug(name);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("candidateSlug", () => {
  test("attempt 1 returns the base unchanged", () => {
    expect(candidateSlug("summer-open", 1)).toBe("summer-open");
  });

  test("attempts 2-9 append a numeric suffix", () => {
    expect(candidateSlug("summer-open", 2)).toBe("summer-open-2");
    expect(candidateSlug("summer-open", 9)).toBe("summer-open-9");
  });

  test("attempt 10+ uses a randomized suffix, different across calls", () => {
    const a = candidateSlug("summer-open", 10);
    const b = candidateSlug("summer-open", 10);
    expect(a).toMatch(/^summer-open-[a-f0-9]{5}$/);
    expect(b).toMatch(/^summer-open-[a-f0-9]{5}$/);
    expect(a).not.toBe(b);
  });
});
