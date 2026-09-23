import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ callAdmin: vi.fn() }));

vi.mock("./api.js", () => ({
  configured: true,
  supabase: { auth: {} },
  callAdmin: mocks.callAdmin,
}));

const { Licenses } = await import("./App.jsx");

const license = (over = {}) => ({
  id: "1",
  email: "buyer@example.com",
  code: "AB2D-3FGH-JK4M",
  status: "unused",
  expired: false,
  activated: false,
  device_label: null,
  device_id_short: null,
  created_at: "2026-01-01T00:00:00Z",
  activated_at: null,
  ...over,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.callAdmin.mockReset();
});

describe("Licenses — Refresh", () => {
  it("fetches fresh data from the backend and shows newly bound licenses", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [license()] });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());

    mocks.callAdmin.mockResolvedValueOnce({
      total: 2,
      items: [license({ id: "2", email: "new@example.com", code: "ZZ2D-3FGH-JK4M", status: "active", activated: true, device_label: "FRONT-DESK" }), license()],
    });
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(screen.queryByText("new@example.com")).not.toBeNull());
    expect(mocks.callAdmin).toHaveBeenCalledTimes(2);
    expect(mocks.callAdmin).toHaveBeenLastCalledWith("list", { search: "" });
    expect(screen.getByText("Licenses (2)")).not.toBeNull();
  });

  it("keeps the current search when refreshing", async () => {
    mocks.callAdmin.mockResolvedValue({ total: 1, items: [license()] });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search licenses"), { target: { value: "buyer" } });
    await waitFor(() => expect(mocks.callAdmin).toHaveBeenCalledWith("list", { search: "buyer" }));
    const before = mocks.callAdmin.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(mocks.callAdmin.mock.calls.length).toBe(before + 1));
    expect(mocks.callAdmin).toHaveBeenLastCalledWith("list", { search: "buyer" });
    expect(screen.getByLabelText("Search licenses").value).toBe("buyer");
  });

  it("shows a loading state and ignores repeat clicks while a refresh is running", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [license()] });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());

    const pending = deferred();
    mocks.callAdmin.mockReturnValueOnce(pending.promise);
    const button = screen.getByRole("button", { name: /refresh/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: /refreshing/i }).disabled).toBe(true));
    expect(mocks.callAdmin).toHaveBeenCalledTimes(2);
    // Existing rows stay visible while refreshing.
    expect(screen.queryByText("buyer@example.com")).not.toBeNull();

    pending.resolve({ total: 1, items: [license()] });
    await waitFor(() => expect(screen.getByRole("button", { name: /^refresh$/i }).disabled).toBe(false));
  });

  it("shows an error and keeps the previous rows when refresh fails", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [license()] });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());

    mocks.callAdmin.mockRejectedValueOnce(new Error("Cannot reach the server. Check your internet connection."));
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Cannot reach the server. Check your internet connection."));
    expect(screen.queryByText("buyer@example.com")).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: /^refresh$/i }).disabled).toBe(false));
  });
});
