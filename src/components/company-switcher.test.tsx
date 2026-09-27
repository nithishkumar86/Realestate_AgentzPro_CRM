import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompanySwitcher } from "@/components/company-switcher";

describe("CompanySwitcher", () => {
  it("shows the active company and links to the company picker", () => {
    render(<CompanySwitcher tenantName="AgentzPro Realty" />);
    const link = screen.getByRole("link", { name: "Switch company (current: AgentzPro Realty)" });

    expect(link).toHaveAttribute("href", "/workspaces");
    expect(link).toHaveTextContent("AgentzPro Realty");
  });
});
