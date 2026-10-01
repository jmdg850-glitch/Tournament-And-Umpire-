import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ callAdmin: vi.fn() }));

vi.mock("./api.js", () => ({
  configured: true,
  supabase: { auth: {} },
  callAdmin: mocks.callAdmin,
}));

const { Generate } = await import("./App.jsx");

describe("Generate", () => {
  beforeEach(() => {
    mocks.callAdmin.mockReset();
  });

  it("calls callAdmin('create', ...) with the entered email, renders the code, and notifies onCreated", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ code: "AB2D-3FGH-JK4M", license: { email: "buyer@example.com" } });
    const onCreated = vi.fn();
    const notify = vi.fn();
    render(<Generate onCreated={onCreated} notify={notify} />);

    fireEvent.change(screen.getByPlaceholderText("customer@example.com"), { target: { value: "buyer@example.com" } });
    fireEvent.click(screen.getByText("Generate"));

    await waitFor(() => expect(screen.getByTestId("access-code").textContent).toBe("AB2D-3FGH-JK4M"));
    expect(mocks.callAdmin).toHaveBeenCalledWith("create", { email: "buyer@example.com", plan: "monthly", max_devices: 1 });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("sends the chosen Allowed devices (default 1) and says how many PCs the code covers", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ code: "AB2D-3FGH-JK4M", license: { email: "buyer@example.com", max_devices: 3 } });
    render(<Generate onCreated={vi.fn()} notify={vi.fn()} />);
    const devices = screen.getByLabelText("Allowed devices");
    expect(devices.value).toBe("1");
    fireEvent.change(screen.getByPlaceholderText("customer@example.com"), { target: { value: "buyer@example.com" } });
    fireEvent.change(devices, { target: { value: "3" } });
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(screen.getByTestId("access-code")).not.toBeNull());
    expect(mocks.callAdmin).toHaveBeenCalledWith("create", { email: "buyer@example.com", plan: "monthly", max_devices: 3 });
    expect(screen.getByText(/on up to 3 PCs/)).not.toBeNull();
    expect(screen.getByLabelText("Allowed devices").value).toBe("1");
  });

  it("Plan: Monthly by default, offers exactly Monthly / Yearly / 30-Day Trial, sends only the plan name (no date field)", async () => {
    mocks.callAdmin.mockResolvedValueOnce({ code: "AB2D-3FGH-JK4M", license: { email: "t@example.com", plan: "trial_30", expires_at: "2026-10-31T12:00:00Z", max_devices: 1 } });
    const { container } = render(<Generate onCreated={vi.fn()} notify={vi.fn()} />);
    const plan = screen.getByLabelText("Plan");
    expect(plan.value).toBe("monthly");
    expect([...plan.options].map((o) => [o.value, o.textContent])).toEqual([["monthly", "Monthly"], ["yearly", "Yearly"], ["trial_30", "30-Day Trial"]]);
    expect(container.querySelector("input[type=date]")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("customer@example.com"), { target: { value: "t@example.com" } });
    fireEvent.change(plan, { target: { value: "trial_30" } });
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(screen.getByTestId("access-code")).not.toBeNull());
    expect(mocks.callAdmin).toHaveBeenCalledWith("create", { email: "t@example.com", plan: "trial_30", max_devices: 1 });
    expect(screen.getByText(/30-Day Trial · expires/)).not.toBeNull();
    expect(screen.getByLabelText("Plan").value).toBe("monthly");
  });

  it("refuses an Allowed devices value outside 1-100 without calling the server", async () => {
    render(<Generate onCreated={vi.fn()} notify={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("customer@example.com"), { target: { value: "buyer@example.com" } });
    for (const bad of ["0", "101", "2.5", ""]) {
      fireEvent.change(screen.getByLabelText("Allowed devices"), { target: { value: bad } });
      fireEvent.submit(screen.getByText("Generate").closest("form"));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/whole number from 1 to 100/));
    }
    expect(mocks.callAdmin).not.toHaveBeenCalled();
  });

  it("shows the literal 'LICENSE GENERATION FAILED' message for a GENERATION_FAILED error", async () => {
    mocks.callAdmin.mockRejectedValueOnce(Object.assign(new Error("LICENSE GENERATION FAILED"), { code: "GENERATION_FAILED" }));
    render(<Generate onCreated={vi.fn()} notify={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("customer@example.com"), { target: { value: "buyer@example.com" } });
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(screen.queryByText("LICENSE GENERATION FAILED")).not.toBeNull());
  });

  it("shows the server's own message for any other error", async () => {
    mocks.callAdmin.mockRejectedValueOnce(Object.assign(new Error("This email already has a license. Revoke it first to issue a new one."), { code: "EMAIL_HAS_LICENSE" }));
    render(<Generate onCreated={vi.fn()} notify={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("customer@example.com"), { target: { value: "buyer@example.com" } });
    fireEvent.click(screen.getByText("Generate"));
    await waitFor(() => expect(screen.queryByText("This email already has a license. Revoke it first to issue a new one.")).not.toBeNull());
  });
});
