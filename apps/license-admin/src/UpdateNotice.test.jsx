import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./api.js", () => ({ configured: true, supabase: { auth: {} }, callAdmin: vi.fn() }));

const { UpdateNotice } = await import("./App.jsx");

function bridge(initial) {
  let listener = null;
  const updates = {
    getState: vi.fn(async () => initial),
    install: vi.fn(async () => ({ ok: true })),
    later: vi.fn(async () => ({ ...initial, status: "idle" })),
    onStatus: vi.fn((cb) => { listener = cb; return () => { listener = null; }; }),
  };
  window.licenseAdminDesktop = { runtime: "electron", updates };
  return { updates, push: (s) => listener?.(s) };
}

describe("UpdateNotice", () => {
  afterEach(() => { delete window.licenseAdminDesktop; });

  it("renders nothing outside the desktop app (web/Android)", () => {
    const { container } = render(<UpdateNotice />);
    expect(container.innerHTML).toBe("");
  });

  it("stays hidden until an update is downloaded, then offers Restart and Later", async () => {
    const { updates, push } = bridge({ status: "idle", availableVersion: null });
    render(<UpdateNotice />);
    await act(async () => {});
    expect(screen.queryByText(/ready/)).toBeNull();

    await act(async () => push({ status: "downloading", percent: 40 }));
    expect(screen.queryByText(/ready/)).toBeNull();

    await act(async () => push({ status: "ready", availableVersion: "1.0.2" }));
    expect(screen.getByText("Update v1.0.2 ready")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByText("Restart")));
    expect(updates.install).toHaveBeenCalledTimes(1);
  });

  it("Later hides the notice", async () => {
    const { updates } = bridge({ status: "ready", availableVersion: "1.0.2" });
    render(<UpdateNotice />);
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByText("Later")));
    expect(updates.later).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/ready/)).toBeNull();
  });
});
