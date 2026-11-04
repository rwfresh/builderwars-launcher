// /proc parsing for the PTY idle check. Pure.

/** Field 8 (tpgid, the terminal's foreground process group) of /proc/<pid>/stat, or null. */
export function tpgidFromProcStat(stat: string): number | null {
  // comm (field 2) is in parentheses and may contain spaces and ')': split after the last ')'.
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  // rest: state(3) ppid(4) pgrp(5) session(6) tty_nr(7) tpgid(8)
  const v = Number(rest[5]);
  return rest[5] != null && Number.isInteger(v) ? v : null;
}
