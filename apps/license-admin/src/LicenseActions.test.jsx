import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { fmtDate } from "./format.js";

const mocks = vi.hoisted(() => ({ callAdmin: vi.fn() }));

vi.mock("./api.js", () => ({
  configured: true,
  supabase: { auth: {} },
  callAdmin: mocks.callAdmin,
}));

const { Licenses } = await import("./App.jsx");

const row = (over) => ({
  code: "AB2D-3FGH-JK4M", status: "active", expired: false, plan: "monthly", renewable: true,
  expires_at: "2099-12-01T00:00:00Z", max_devices: 3, active_devices: 0, over_limit: false, devices: [],
  created_at: "2026-01-01T00:00:00Z", ...over,
});
const ROWS = [
  row({ id: "a", email: "active@example.com", active_devices: 2 }),
  row({ id: "u", email: "unused@example.com", status: "unused", plan: "yearly" }),
  row({ id: "e", email: "expired@example.com", expired: true, expires_at: "2026-02-01T00:00:00Z" }),
  row({ id: "r", email: "revoked@example.com", status: "revoked", plan: "legacy", renewable: false, expires_at: null }),
  row({ id: "t", email: "trial@example.com", plan: "trial_30", renewable: false }),
];
const EMAILS = ROWS.map((r) => r.email);

beforeEach(() => {
  mocks.callAdmin.mockReset();
});

async function renderList(items = ROWS, props = {}) {
  mocks.callAdmin.mockResolvedValueOnce({ total: items.length, items });
  const notify = vi.fn();
  const onChanged = vi.fn();
  render(<Licenses refreshKey={0} onChanged={onChanged} notify={notify} {...props} />);
  await waitFor(() => expect(screen.queryByText(items[0].email)).not.toBeNull());
  return { notify, onChanged };
}
const visible = () => EMAILS.filter((e) => screen.queryByText(e));
const filterTo = (value) => fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value } });
const rowOf = (email) => screen.getByText(email).closest("tr");

describe("status filter", () => {
  it("1: All (default) shows every license; options are the statuses the app already uses", async () => {
    await renderList();
    const select = screen.getByLabelText("Filter by status");
    expect(select.value).toBe("all");
    expect([...select.options].map((o) => o.textContent)).toEqual(["All", "Activated", "Not activated", "Expired", "Revoked"]);
    expect(visible()).toEqual(EMAILS);
  });

  it("2-4: Activated / Revoked / Expired show only matching licenses, without calling the server", async () => {
    await renderList();
    filterTo("active");
    expect(visible()).toEqual(["active@example.com", "trial@example.com"]);
    filterTo("revoked");
    expect(visible()).toEqual(["revoked@example.com"]);
    filterTo("expired");
    expect(visible()).toEqual(["expired@example.com"]);
    filterTo("unused");
    expect(visible()).toEqual(["unused@example.com"]);
    expect(screen.getByRole("heading", { name: /Licenses \(1 of 5\)/ })).not.toBeNull();
    filterTo("all");
    expect(visible()).toEqual(EMAILS);
    expect(mocks.callAdmin).toHaveBeenCalledTimes(1);
  });

  it("5: an empty filtered result says so (distinct from having no licenses at all)", async () => {
    await renderList(ROWS.filter((r) => r.status !== "revoked"));
    filterTo("revoked");
    expect(screen.getByText("No licenses found for this status.")).not.toBeNull();
    expect(screen.queryByText("No licenses yet. Generate one above.")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows plan and expiry per license", async () => {
    await renderList();
    expect(within(rowOf("trial@example.com")).getByText("30-Day Trial")).not.toBeNull();
    expect(within(rowOf("unused@example.com")).getByText("Yearly")).not.toBeNull();
    expect(within(rowOf("revoked@example.com")).getByText("Never")).not.toBeNull();
    expect(within(rowOf("expired@example.com")).getByText(fmtDate("2026-02-01T00:00:00Z"))).not.toBeNull();
  });
});

describe("delete", () => {
  it("6-7: Delete opens a confirmation with email, code, status, plan and devices; Cancel deletes nothing", async () => {
    await renderList();
    fireEvent.click(within(rowOf("active@example.com")).getByText("Delete"));
    const dialog = screen.getByRole("dialog", { name: "Delete this license?" });
    for (const text of ["active@example.com", "AB2D-3FGH-JK4M", "Activated", "Monthly", "2"]) {
      expect(within(dialog).getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(within(dialog).getByText(/permanently deletes the license.*cannot be undone/)).not.toBeNull();
    fireEvent.click(within(dialog).getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.callAdmin).toHaveBeenCalledTimes(1); // only the list load
    expect(screen.queryByText("active@example.com")).not.toBeNull();
  });

  it("8-9: Confirm calls the server's delete action, removes the row, toasts, and keeps the status filter", async () => {
    const { notify, onChanged } = await renderList();
    filterTo("active");
    mocks.callAdmin.mockResolvedValueOnce({ deleted: "a" });
    fireEvent.click(within(rowOf("active@example.com")).getByText("Delete"));
    fireEvent.click(screen.getByText("Delete License"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("License deleted"));
    expect(mocks.callAdmin).toHaveBeenCalledWith("delete", { id: "a" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("active@example.com")).toBeNull();
    expect(screen.getByLabelText("Filter by status").value).toBe("active");
    expect(visible()).toEqual(["trial@example.com"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("10: a failed delete keeps the license and the dialog, and shows the server's error", async () => {
    const { notify } = await renderList();
    mocks.callAdmin.mockRejectedValueOnce(Object.assign(new Error("License not found."), { code: "NOT_FOUND" }));
    fireEvent.click(within(rowOf("active@example.com")).getByText("Delete"));
    fireEvent.click(screen.getByText("Delete License"));
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("License not found."));
    expect(screen.getAllByText("active@example.com").length).toBeGreaterThan(0);
    expect(notify).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Delete License").disabled).toBe(false);
  });

  it("11: while deleting, both buttons are disabled and a second click sends nothing", async () => {
    const { notify } = await renderList();
    let finish;
    mocks.callAdmin.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(within(rowOf("active@example.com")).getByText("Delete"));
    fireEvent.click(screen.getByText("Delete License"));
    const dialog = screen.getByRole("dialog");
    const busyBtn = within(dialog).getByText("Working…");
    expect(busyBtn.disabled).toBe(true);
    expect(within(dialog).getByText("Cancel").disabled).toBe(true);
    fireEvent.click(busyBtn);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).not.toBeNull();
    finish({ deleted: "a" });
    await waitFor(() => expect(notify).toHaveBeenCalledWith("License deleted"));
    expect(mocks.callAdmin.mock.calls.filter(([action]) => action === "delete")).toHaveLength(1);
  });
});

describe("renew", () => {
  it("only Monthly/Yearly licenses that are not revoked offer Renew", async () => {
    await renderList();
    expect(within(rowOf("active@example.com")).queryByText("Renew")).not.toBeNull();
    expect(within(rowOf("unused@example.com")).queryByText("Renew")).not.toBeNull();
    expect(within(rowOf("expired@example.com")).queryByText("Renew")).not.toBeNull();
    expect(within(rowOf("trial@example.com")).queryByText("Renew")).toBeNull();
    expect(within(rowOf("revoked@example.com")).queryByText("Renew")).toBeNull();
  });

  it("27: Renew confirms with email, plan, current and new expiry, then calls the server's renew action", async () => {
    const { notify } = await renderList([row({ id: "a", email: "active@example.com", expires_at: "2099-12-01T00:00:00Z" })]);
    fireEvent.click(screen.getByText("Renew"));
    const dialog = screen.getByRole("dialog", { name: "Renew this license?" });
    expect(within(dialog).getByText("active@example.com")).not.toBeNull();
    expect(within(dialog).getByText("Monthly")).not.toBeNull();
    expect(within(dialog).getByText(fmtDate("2099-12-01T00:00:00Z"))).not.toBeNull();
    expect(within(dialog).getByTestId("renew-new-expiry").textContent).toBe(fmtDate("2100-01-01T00:00:00Z"));
    fireEvent.click(within(dialog).getByText("Cancel"));
    expect(mocks.callAdmin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Renew"));
    mocks.callAdmin.mockResolvedValueOnce({ license: row({ id: "a", expires_at: "2100-01-01T00:00:00Z" }) });
    fireEvent.click(screen.getByText("Renew license"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("License renewed"));
    expect(mocks.callAdmin).toHaveBeenCalledWith("renew", { id: "a" });
  });

  it("an expired license's renewal starts today; a refused renewal shows the error and keeps the dialog", async () => {
    const { notify } = await renderList([row({ id: "e", email: "expired@example.com", expired: true, expires_at: "2026-01-01T00:00:00Z" })]);
    fireEvent.click(screen.getByText("Renew"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/has expired, so the new period starts today/)).not.toBeNull();
    expect(Date.parse(within(dialog).getByTestId("renew-new-expiry").textContent)).toBeGreaterThan(Date.now());
    mocks.callAdmin.mockRejectedValueOnce(Object.assign(new Error("That change is not allowed for this license's current status."), { code: "INVALID_STATE" }));
    fireEvent.click(screen.getByText("Renew license"));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/not allowed/));
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("change plan (legacy -> Monthly / Yearly)", () => {
  const legacy = (over) => row({ plan: "legacy", renewable: false, expires_at: null, ...over });
  const MIXED = [
    legacy({ id: "l", email: "legacy@example.com", active_devices: 1 }),
    legacy({ id: "lu", email: "legacy-unused@example.com", status: "unused" }),
    legacy({ id: "lr", email: "legacy-revoked@example.com", status: "revoked" }),
    row({ id: "m", email: "monthly@example.com", plan: "monthly" }),
    row({ id: "y", email: "yearly@example.com", plan: "yearly" }),
    row({ id: "t", email: "trial@example.com", plan: "trial_30", renewable: false }),
  ];

  it("appears only on legacy licenses that are not revoked", async () => {
    await renderList(MIXED);
    const has = (email) => within(rowOf(email)).queryByText("Change Plan") !== null;
    expect(has("legacy@example.com")).toBe(true);
    expect(has("legacy-unused@example.com")).toBe(true);
    expect(has("legacy-revoked@example.com")).toBe(false);
    expect(has("monthly@example.com")).toBe(false);
    expect(has("yearly@example.com")).toBe(false);
    expect(has("trial@example.com")).toBe(false);
    // Legacy licenses are still not renewable until they get a plan.
    expect(within(rowOf("legacy@example.com")).queryByText("Renew")).toBeNull();
  });

  it("dialog shows email, current plan, Monthly/Yearly only, and current/new expiration; Cancel changes nothing", async () => {
    await renderList([legacy({ id: "l", email: "legacy@example.com", expires_at: "2099-01-31T10:00:00Z" })]);
    fireEvent.click(screen.getByText("Change Plan"));
    const dialog = screen.getByRole("dialog", { name: "Change license plan?" });
    expect(within(dialog).getByText("legacy@example.com")).not.toBeNull();
    expect(within(dialog).getByText("Legacy – no plan")).not.toBeNull();
    const select = within(dialog).getByLabelText("New plan");
    expect([...select.options].map((o) => o.value)).toEqual(["monthly", "yearly"]);
    expect(select.value).toBe("monthly");
    expect(within(dialog).getByText(fmtDate("2099-01-31T10:00:00Z"))).not.toBeNull();
    expect(within(dialog).getByTestId("change-plan-new-expiry").textContent).toBe(fmtDate("2099-02-28T10:00:00Z"));
    fireEvent.change(select, { target: { value: "yearly" } });
    expect(within(dialog).getByTestId("change-plan-new-expiry").textContent).toBe(fmtDate("2100-01-31T10:00:00Z"));
    expect(within(dialog).getByText(/also sets a new expiration/)).not.toBeNull();
    fireEvent.click(within(dialog).getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.callAdmin).toHaveBeenCalledTimes(1);
  });

  it("success: calls change_plan with the chosen plan, updates the row, toasts, keeps the status filter", async () => {
    const { notify, onChanged } = await renderList(MIXED);
    filterTo("active");
    fireEvent.click(within(rowOf("legacy@example.com")).getByText("Change Plan"));
    fireEvent.change(screen.getByLabelText("New plan"), { target: { value: "yearly" } });
    mocks.callAdmin.mockResolvedValueOnce({ license: { ...MIXED[0], plan: "yearly", renewable: true, expires_at: "2027-10-02T12:00:00Z" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Change Plan"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Plan changed"));
    expect(mocks.callAdmin).toHaveBeenCalledWith("change_plan", { id: "l", plan: "yearly" });
    expect(screen.queryByRole("dialog")).toBeNull();
    const updated = rowOf("legacy@example.com");
    expect(within(updated).getByText("Yearly")).not.toBeNull();
    expect(within(updated).getByText(fmtDate("2027-10-02T12:00:00Z"))).not.toBeNull();
    expect(within(updated).queryByText("Change Plan")).toBeNull();
    expect(within(updated).queryByText("Renew")).not.toBeNull();
    expect(screen.getByLabelText("Filter by status").value).toBe("active");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("failure keeps the dialog open with the server error and leaves the row unchanged", async () => {
    const { notify } = await renderList([legacy({ id: "l", email: "legacy@example.com" })]);
    fireEvent.click(screen.getByText("Change Plan"));
    mocks.callAdmin.mockRejectedValueOnce(Object.assign(new Error("That change is not allowed for this license's current status."), { code: "INVALID_STATE" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("Change Plan"));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/not allowed/));
    expect(notify).not.toHaveBeenCalled();
    const tableRow = within(screen.getByRole("table")).getByText("legacy@example.com").closest("tr");
    expect(within(tableRow).getByText("Legacy – no plan")).not.toBeNull();
    expect(within(dialog).getByText("Change Plan").disabled).toBe(false);
  });

  it("while saving, both buttons and the plan choice are disabled and a second click sends nothing", async () => {
    const { notify } = await renderList([legacy({ id: "l", email: "legacy@example.com" })]);
    let finish;
    mocks.callAdmin.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByText("Change Plan"));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("Change Plan"));
    const busyBtn = within(dialog).getByText("Working…");
    expect(busyBtn.disabled).toBe(true);
    expect(within(dialog).getByText("Cancel").disabled).toBe(true);
    expect(within(dialog).getByLabelText("New plan").disabled).toBe(true);
    fireEvent.click(busyBtn);
    finish({ license: { plan: "monthly", renewable: true, expires_at: "2026-11-02T12:00:00Z" } });
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Plan changed"));
    expect(mocks.callAdmin.mock.calls.filter(([action]) => action === "change_plan")).toHaveLength(1);
  });
});
