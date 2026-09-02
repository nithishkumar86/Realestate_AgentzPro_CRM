import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toReadableLabel } from "@/lib/date-utils";
import { displayValue } from "@/components/ui";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("lead display helpers", () => {
  it("shows missing values as an em dash", () => {
    expect(displayValue(null)).toBe("—");
    expect(displayValue("")).toBe("—");
    expect(displayValue("Kumar")).toBe("Kumar");
  });

  it("renders readable dynamic lead fields without raw JSON", () => {
    render(
      <dl>
        <dt>{toReadableLabel("preferred_location")}</dt>
        <dd>Anna Nagar</dd>
      </dl>,
    );

    expect(screen.getByText("Preferred Location")).toBeInTheDocument();
    expect(screen.queryByText(/{"preferred_location"/)).not.toBeInTheDocument();
  });
});
