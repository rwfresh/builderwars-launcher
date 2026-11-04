// Environment for processes the launcher starts (PTY shell, herdr CLI).

/**
 * If the launcher itself was started from inside herdr, do not leak that context:
 * herdr refuses to nest and would target the outer session.
 */
export const HERDR_ENV_VARS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_BIN_PATH",
] as const;

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v;
  for (const k of HERDR_ENV_VARS) delete env[k];
  return { ...env, ...extra };
}
