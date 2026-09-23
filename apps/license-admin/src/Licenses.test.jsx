import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";

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

beforeEach(() => {
  mocks.callAdmin.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Licenses", () => {
  it("shows the empty-state message when there are no licenses", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 0, items: [] });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("No licenses yet. Generate one above.")).not.toBeNull());
  });

  it("renders a populated table", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [license()] });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());
    expect(screen.getByText("AB2D-3FGH-JK4M")).not.toBeNull();
  });

  it("shows an API error (e.g. a network failure) in an alert", async () => {
    mocks.callAdmin.mockRejectedValueOnce(Object.assign(new Error("Cannot reach the server. Check your internet connection."), { code: "NETWORK" }));
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Cannot reach the server. Check your internet connection."));
  });

  it("debounces search: no second callAdmin call until ~250ms after typing", async () => {
    vi.useFakeTimers();
    mocks.callAdmin.mockResolvedValue({ total: 0, items: [] });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.callAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.callAdmin).toHaveBeenLastCalledWith("list", { search: "" });

    fireEvent.change(screen.getByLabelText("Search licenses"), { target: { value: "buyer" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(mocks.callAdmin).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.callAdmin).toHaveBeenCalledTimes(2);
    expect(mocks.callAdmin).toHaveBeenLastCalledWith("list", { search: "buyer" });
  });

  it("revoke: Cancel closes the dialog without calling the server; Confirm calls callAdmin('revoke', {id}) and notifies", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [license()] });
    const notify = vi.fn();
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={notify} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());

    fireEvent.click(screen.getByText("Revoke"));
    expect(screen.getByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.callAdmin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Revoke"));
    mocks.callAdmin.mockResolvedValueOnce({ license: license({ status: "revoked" }) });
    fireEvent.click(screen.getByText("Revoke license"));

    await waitFor(() => expect(notify).toHaveBeenCalledWith("License revoked"));
    expect(mocks.callAdmin).toHaveBeenCalledWith("revoke", { id: "1" });
  });

  it("release: Confirm calls callAdmin('release', {id}) and notifies", async () => {
    const activated = license({ activated: true, status: "active", device_label: "SELLER-PC" });
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [activated] });
    const notify = vi.fn();
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={notify} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());

    fireEvent.click(screen.getByText("Release PC"));
    const dialog = screen.getByRole("dialog");
    mocks.callAdmin.mockResolvedValueOnce({ license: license({ status: "unused" }) });
    fireEvent.click(within(dialog).getByText("Release PC"));

    await waitFor(() => expect(notify).toHaveBeenCalledWith("PC released"));
    expect(mocks.callAdmin).toHaveBeenCalledWith("release", { id: "1" });
  });
});
