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
    expect(mocks.callAdmin).toHaveBeenCalledWith("create", { email: "buyer@example.com" });
    expect(onCreated).toHaveBeenCalledTimes(1);
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
