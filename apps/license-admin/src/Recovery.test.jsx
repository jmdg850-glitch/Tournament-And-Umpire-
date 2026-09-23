import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ updateUser: vi.fn(async () => ({ error: null })) }));

vi.mock("./api.js", () => ({
  configured: true,
  supabase: { auth: { updateUser: mocks.updateUser } },
  callAdmin: vi.fn(),
}));

const { Recovery } = await import("./App.jsx");

describe("Recovery", () => {
  it("shows an error and does not call onDone when the password update fails", async () => {
    mocks.updateUser.mockResolvedValueOnce({ error: { message: "Password too short" } });
    const onDone = vi.fn();
    render(<Recovery onDone={onDone} />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.click(screen.getByText("Save password"));
    await waitFor(() => expect(screen.queryByText("Could not update the password. Use at least 8 characters.")).not.toBeNull());
    expect(onDone).not.toHaveBeenCalled();
  });

  it("calls onDone when the password update succeeds", async () => {
    const onDone = vi.fn();
    render(<Recovery onDone={onDone} />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-good-password" } });
    fireEvent.click(screen.getByText("Save password"));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});
