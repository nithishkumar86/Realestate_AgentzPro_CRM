import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompanySwitcher } from "@/components/company-switcher";

describe("CompanySwitcher", () => {
  it("shows the company name and offers no way to switch company", () => {
    render(<CompanySwitcher tenantName="AgentzPro Realty" />);

    expect(screen.getByText("AgentzPro Realty")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
