// Smoke-level check only: proves the component tree renders without crashing
// at a narrow, phone-width viewport in jsdom. It does NOT verify real layout,
// touch behavior, or the @media rules in styles.css — that needs a device or
// emulator pass, which is out of scope for this test file.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  callAdmin: vi.fn(async (action) => {
    if (action === "whoami") return { admin: true, user_id: "u1", email: "admin@example.com" };
    if (action === "list") return { total: 0, items: [] };
    throw new Error(`unexpected action ${action}`);
  }),
  getSession: vi.fn(async () => ({ data: { session: { user: { id: "u1", email: "admin@example.com" }, access_token: "tok" } } })),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));

vi.mock("./api.js", () => ({
  configured: true,
  supabase: { auth: { getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange, signOut: vi.fn() } },
  callAdmin: mocks.callAdmin,
}));

const App = (await import("./App.jsx")).default;

describe("mobile-safe rendering", () => {
  it("renders without crashing at a narrow (360px) viewport width", async () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 360 });
    window.dispatchEvent(new Event("resize"));

    render(<App />);

    await waitFor(() => expect(screen.queryByText("Generate access code")).not.toBeNull());
    expect(screen.getByLabelText("Search licenses")).not.toBeNull();
  });
});
