import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InvitationWithdrawnClient } from "@/features/auth/invitation-withdrawn-client";

describe("InvitationWithdrawnClient", () => {
  it("shows only the withdrawn message, with nothing to click", () => {
    render(<InvitationWithdrawnClient tenantName="QA Test Co" />);

    expect(screen.getByRole("heading", { name: "Invitation withdrawn" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The invitation to join QA Test Co was withdrawn by the organization owner");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
