import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders the given message", () => {
    render(<EmptyState message="No tasks yet." />);
    expect(screen.getByText("No tasks yet.")).toBeInTheDocument();
  });
});
