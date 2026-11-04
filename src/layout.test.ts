import { describe, expect, it } from "vitest";
import { COLLAPSED_PX, DEFAULT_LAYOUT, DIVIDER_PX, MIN_PX, computeColumns, dragDivider, nextFocus, toggleCollapsed } from "./layout";

const sum = (c: { terminal: number; game: number; xpane: number }) => c.terminal + c.game + c.xpane + 2 * DIVIDER_PX;

describe("computeColumns", () => {
  it("fills the width with the game column taking the remainder", () => {
    const c = computeColumns(1600, DEFAULT_LAYOUT);
    expect(c.terminal).toBe(560);
    expect(c.xpane).toBe(520);
    expect(sum(c)).toBe(1600);
  });

  it("shrinks side columns to keep the game column usable", () => {
    const c = computeColumns(1100, DEFAULT_LAYOUT);
    expect(c.game).toBeGreaterThanOrEqual(MIN_PX.game);
    expect(sum(c)).toBe(1100);
  });

  it("collapsed columns become thin strips", () => {
    const s = toggleCollapsed(DEFAULT_LAYOUT, "xpane");
    const c = computeColumns(1600, s);
    expect(c.xpane).toBe(COLLAPSED_PX);
    expect(sum(c)).toBe(1600);
  });

  it("collapsed game lets the side columns share the space", () => {
    const c = computeColumns(1600, toggleCollapsed(DEFAULT_LAYOUT, "game"));
    expect(c.game).toBe(COLLAPSED_PX);
    expect(sum(c)).toBe(1600);
  });
});

describe("dragDivider", () => {
  it("clamps to minimum widths", () => {
    expect(dragDivider(DEFAULT_LAYOUT, 0, -10_000, 1600).left).toBe(MIN_PX.terminal);
    expect(dragDivider(DEFAULT_LAYOUT, 1, 10_000, 1600).right).toBe(MIN_PX.xpane);
    const wide = dragDivider(DEFAULT_LAYOUT, 0, 10_000, 1600);
    expect(computeColumns(1600, wide).game).toBe(MIN_PX.game);
  });
});

describe("dragDivider from a squeezed layout", () => {
  it("moves relative to the on-screen widths", () => {
    const before = computeColumns(1354, DEFAULT_LAYOUT);
    // X was squeezed to 422px (preferred 520); dragging the right divider right by 40 shrinks it
    // from what is on screen (382), not from the preferred width (480).
    const after = computeColumns(1354, dragDivider(DEFAULT_LAYOUT, 1, 40, 1354));
    expect(before.xpane).toBe(422);
    expect(after.xpane).toBe(382);
    expect(sum(after)).toBe(1354);
  });
});

describe("nextFocus", () => {
  it("cycles and skips collapsed panes", () => {
    const none = DEFAULT_LAYOUT.collapsed;
    expect(nextFocus("terminal", none)).toBe("game");
    expect(nextFocus("xpane", none)).toBe("terminal");
    expect(nextFocus("terminal", { ...none, game: true })).toBe("xpane");
  });
});
