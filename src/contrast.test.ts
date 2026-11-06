import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "./contrast";

describe("WCAG contrast", () => {
  it("matches the reference values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBe(1);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#1d9bf0", "#1d9bf0")).toBe(1);
    // #767676 is the classic lightest grey that passes 4.5:1 on white; #777777 just misses.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#ffffff", "#777777")).toBeCloseTo(4.48, 2);
  });

  it("rejects colors it can't measure", () => {
    expect(() => relativeLuminance("#fff")).toThrow();
    expect(() => relativeLuminance("#1d9bf059")).toThrow();
    expect(() => relativeLuminance("rgba(0, 0, 0, 0.1)")).toThrow();
  });
});
