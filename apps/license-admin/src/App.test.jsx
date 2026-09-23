import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  callAdmin: vi.fn(),
  getSession: vi.fn(async () => ({ data: { session: { user: { id: "u1", email: "admin@example.com" }, access_token: "tok" } } })),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  signOut: vi.fn(async () => ({})),
}));

vi.mock("./api.js", () => ({
  configured: true,
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      signOut: mocks.signOut,
    },
  },
  callAdmin: mocks.callAdmin,
}));

const App = (await import("./App.jsx")).default;

describe("App", () => {
  beforeEach(() => {
    mocks.callAdmin.mockReset();
  });

  it("shows Access denied (and never the admin UI) when the server's whoami check rejects with FORBIDDEN", async () => {
    mocks.callAdmin.mockRejectedValueOnce(Object.assign(new Error("You do not have access to this resource."), { code: "FORBIDDEN" }));

    render(<App />);

    await waitFor(() => expect(screen.queryByText("Access denied")).not.toBeNull());
    expect(screen.queryByText("Generate access code")).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Licenses/ })).toBeNull();
  });

  it("renders the admin console once whoami succeeds", async () => {
    mocks.callAdmin.mockImplementation(async (action) => {
      if (action === "whoami") return { admin: true, user_id: "u1", email: "admin@example.com" };
      if (action === "list") return { total: 0, items: [] };
      throw new Error(`unexpected action ${action}`);
    });

    render(<App />);

    await waitFor(() => expect(screen.queryByText("Generate access code")).not.toBeNull());
    expect(screen.queryByText("Access denied")).toBeNull();
  });
});
