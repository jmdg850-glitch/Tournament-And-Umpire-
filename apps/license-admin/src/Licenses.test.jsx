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

  const device = (id, label, over = {}) => ({
    id, label, device_id_short: `win-${id}…`, first_activated_at: "2026-02-01T00:00:00Z", last_seen_at: "2026-03-01T00:00:00Z", released_at: null, ...over,
  });
  const multi = (over = {}) => license({
    status: "active", activated: true, max_devices: 3, active_devices: 2, over_limit: false,
    devices: [device("d1", "FRONT-DESK"), device("d2", "COURT-SIDE"), device("d0", "OLD-LAPTOP", { released_at: "2026-02-15T00:00:00Z" })],
    ...over,
  });

  it("shows device usage as 'used / max devices' and flags a license that is over its limit", async () => {
    mocks.callAdmin.mockResolvedValueOnce({
      total: 2,
      items: [multi(), multi({ id: "2", email: "big@example.com", max_devices: 3, active_devices: 5, over_limit: true })],
    });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());
    expect(screen.getByTestId("usage-1").textContent).toMatch(/2 \/ 3 devices/);
    expect(screen.getByTestId("usage-2").textContent).toMatch(/5 \/ 3 devices/);
    expect(screen.getAllByText("Over limit")).toHaveLength(1);
  });

  it("device details list registered devices; Release confirms and calls release_device for THAT device of THAT license", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [multi()] });
    const notify = vi.fn();
    const onChanged = vi.fn();
    render(<Licenses refreshKey={0} onChanged={onChanged} notify={notify} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    expect(screen.getByText("2 of 3 devices in use.")).not.toBeNull();
    expect(screen.getByText("FRONT-DESK")).not.toBeNull();
    expect(screen.getByText("COURT-SIDE")).not.toBeNull();
    // Only active devices get a Release button; the released one is history.
    expect(screen.getAllByText("Release")).toHaveLength(2);
    expect(screen.getByText("Released devices (1)")).not.toBeNull();

    const courtSide = screen.getByText("COURT-SIDE").closest("li");
    fireEvent.click(within(courtSide).getByText("Release"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("COURT-SIDE")).not.toBeNull();
    mocks.callAdmin.mockResolvedValueOnce({ license: multi({ active_devices: 1 }) });
    fireEvent.click(within(dialog).getByText("Release device"));

    await waitFor(() => expect(notify).toHaveBeenCalledWith("Device released"));
    expect(mocks.callAdmin).toHaveBeenCalledWith("release_device", { license_id: "1", device_id: "d2" });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("edit limit: Save calls set_max_devices; lowering below usage warns but never releases devices", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [multi()] });
    const notify = vi.fn();
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={notify} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Devices" }));

    const input = screen.getByLabelText("Allowed devices for buyer@example.com");
    expect(input.value).toBe("3");
    expect(screen.getByText("Save").disabled).toBe(true);

    fireEvent.change(input, { target: { value: "1" } });
    expect(screen.getByText(/keeps the current devices; no new PC can activate until usage is below 1/)).not.toBeNull();
    mocks.callAdmin.mockResolvedValueOnce({ license: multi({ max_devices: 1, over_limit: true }) });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Device limit saved"));
    expect(mocks.callAdmin).toHaveBeenCalledWith("set_max_devices", { id: "1", max_devices: 1 });
    expect(mocks.callAdmin.mock.calls.some(([action]) => action.startsWith("release"))).toBe(false);

    fireEvent.change(input, { target: { value: "0" } });
    // The browser's own min/max check would stop a click; submit directly to
    // prove the app's validation also refuses it without calling the server.
    fireEvent.submit(input.closest("form"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/whole number from 1 to 100/));
    expect(mocks.callAdmin).toHaveBeenCalledTimes(2);
  });

  it("a revoked license shows its devices but offers no Release, limit edit or Revoke", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ total: 1, items: [multi({ status: "revoked" })] });
    render(<Licenses refreshKey={0} onChanged={vi.fn()} notify={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("buyer@example.com")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    expect(screen.getByText("FRONT-DESK")).not.toBeNull();
    expect(screen.queryByText("Release")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
    expect(screen.queryByText("Revoke")).toBeNull();
  });
});
