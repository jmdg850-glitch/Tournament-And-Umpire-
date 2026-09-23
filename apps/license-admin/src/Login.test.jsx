import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(async () => ({ error: null })),
  resetPasswordForEmail: vi.fn(async () => ({ error: null })),
}));

vi.mock("./api.js", () => ({
  configured: true,
  supabase: { auth: { signInWithPassword: mocks.signInWithPassword, resetPasswordForEmail: mocks.resetPasswordForEmail } },
  callAdmin: vi.fn(),
}));

const { Login } = await import("./App.jsx");

describe("Login", () => {
  it("renders email and password fields by default, in sign-in mode", () => {
    render(<Login />);
    expect(screen.getByLabelText("Email")).not.toBeNull();
    expect(screen.getByLabelText("Password")).not.toBeNull();
    expect(screen.getByText("Sign in")).not.toBeNull();
  });

  it("shows an error message when sign-in fails", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({ error: { message: "Invalid login credentials" } });
    render(<Login />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "seller@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByText("Sign in"));
    await waitFor(() => expect(screen.queryByText("Invalid email or password.")).not.toBeNull());
  });

  it("toggling Forgot password switches to reset mode (no password field) and shows the confirmation on success", async () => {
    render(<Login />);
    fireEvent.click(screen.getByText("Forgot password?"));
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByText("Send reset link")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "seller@example.com" } });
    fireEvent.click(screen.getByText("Send reset link"));
    await waitFor(() => expect(screen.queryByText("If that account exists, a reset link is on its way.")).not.toBeNull());
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith("seller@example.com", expect.any(Object));
  });
});
