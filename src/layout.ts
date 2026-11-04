// Pure layout math for the three columns (terminal | game | X). Unit-tested.

export type PaneId = "terminal" | "game" | "xpane";
export const PANE_ORDER: readonly PaneId[] = ["terminal", "game", "xpane"];

export const COLLAPSED_PX = 28;
export const DIVIDER_PX = 6;
export const MIN_PX: Record<PaneId, number> = { terminal: 300, game: 360, xpane: 320 };

export interface LayoutState {
  /** Preferred width of the terminal column (px). */
  left: number;
  /** Preferred width of the X column (px). */
  right: number;
  collapsed: Record<PaneId, boolean>;
}

export const DEFAULT_LAYOUT: LayoutState = {
  left: 560,
  right: 520,
  collapsed: { terminal: false, game: false, xpane: false },
};

export interface Columns {
  terminal: number;
  game: number;
  xpane: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Resolve actual column widths for a total width. The game column takes the remainder. */
export function computeColumns(total: number, s: LayoutState): Columns {
  const avail = Math.max(0, total - 2 * DIVIDER_PX);
  const w = (p: PaneId, preferred: number) => (s.collapsed[p] ? COLLAPSED_PX : preferred);
  let left = w("terminal", s.left);
  let right = w("xpane", s.right);
  if (s.collapsed.game) {
    // Game collapsed: the open side columns share the space.
    const game = COLLAPSED_PX;
    const rest = avail - game;
    if (!s.collapsed.terminal && !s.collapsed.xpane) {
      left = Math.round((rest * s.left) / (s.left + s.right));
      right = rest - left;
    } else if (!s.collapsed.terminal) {
      left = rest - right;
    } else if (!s.collapsed.xpane) {
      right = rest - left;
    }
    return { terminal: left, game, xpane: right };
  }
  // Keep the game column at least its minimum by shrinking the side columns (not below their minimum).
  const minGame = MIN_PX.game;
  let over = left + right + minGame - avail;
  if (over > 0 && !s.collapsed.xpane) {
    const cut = Math.min(over, right - MIN_PX.xpane);
    if (cut > 0) {
      right -= cut;
      over -= cut;
    }
  }
  if (over > 0 && !s.collapsed.terminal) {
    const cut = Math.min(over, left - MIN_PX.terminal);
    if (cut > 0) left -= cut;
  }
  return { terminal: left, game: Math.max(0, avail - left - right), xpane: right };
}

/** Apply a divider drag. Divider 0 sits between terminal and game, divider 1 between game and X. */
export function dragDivider(state: LayoutState, divider: 0 | 1, dx: number, total: number): LayoutState {
  // Start from what is on screen: preferred widths may exceed the window and be squeezed.
  const c = computeColumns(total, state);
  const s: LayoutState = {
    ...state,
    left: state.collapsed.terminal ? state.left : c.terminal,
    right: state.collapsed.xpane ? state.right : c.xpane,
  };
  const avail = total - 2 * DIVIDER_PX;
  if (divider === 0) {
    const other = s.collapsed.xpane ? COLLAPSED_PX : s.right;
    const max = avail - other - (s.collapsed.game ? COLLAPSED_PX : MIN_PX.game);
    return { ...s, left: clamp(s.left + dx, MIN_PX.terminal, max) };
  }
  const other = s.collapsed.terminal ? COLLAPSED_PX : s.left;
  const max = avail - other - (s.collapsed.game ? COLLAPSED_PX : MIN_PX.game);
  return { ...s, right: clamp(s.right - dx, MIN_PX.xpane, max) };
}

export function toggleCollapsed(s: LayoutState, pane: PaneId, collapsed?: boolean): LayoutState {
  return { ...s, collapsed: { ...s.collapsed, [pane]: collapsed ?? !s.collapsed[pane] } };
}

/** Next pane to focus, skipping collapsed ones. */
export function nextFocus(current: PaneId, collapsed: Record<PaneId, boolean>): PaneId {
  const i = PANE_ORDER.indexOf(current);
  for (let k = 1; k <= PANE_ORDER.length; k++) {
    const p = PANE_ORDER[(i + k) % PANE_ORDER.length]!;
    if (!collapsed[p]) return p;
  }
  return current;
}
