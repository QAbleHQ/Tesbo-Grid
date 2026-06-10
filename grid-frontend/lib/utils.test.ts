import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("returns a single class unchanged", () => {
    expect(cn("foo")).toBe("foo");
  });

  it("merges multiple classes", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("deduplicates conflicting Tailwind utilities — last one wins", () => {
    expect(cn("p-4", "p-8")).toBe("p-8");
  });

  it("deduplicates conflicting text-color utilities", () => {
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("handles conditional classes via object syntax", () => {
    expect(cn({ "font-bold": true, italic: false })).toBe("font-bold");
  });

  it("handles conditional classes via array syntax", () => {
    expect(cn(["flex", false && "hidden", "items-center"])).toBe("flex items-center");
  });

  it("ignores falsy values", () => {
    expect(cn(null, undefined, false, "", "visible")).toBe("visible");
  });

  it("returns an empty string when all inputs are falsy", () => {
    expect(cn(null, undefined, false)).toBe("");
  });

  it("merges mixed conditional and unconditional classes correctly", () => {
    const active = true;
    const result = cn("btn", active && "btn-primary", "text-sm");
    expect(result).toBe("btn btn-primary text-sm");
  });
});
