// User agent for the persist:web session. Pure.

/**
 * Chromium's default UA minus the app tokens, so sites see a normal Chrome UA (Google refuses
 * sign-in to UAs that advertise embedded apps). Nothing else is spoofed.
 */
export function chromeUserAgent(defaultUa: string, appName: string, appVersion: string): string {
  let ua = defaultUa.replace(/ (Electron|builderwars-launcher|@builderwars\/launcher)\/\S+/gi, "");
  // Electron inserts "<app name without spaces>/<version>" (e.g. "BuilderWars/0.1.0").
  for (const name of new Set([appName, appName.replace(/\s+/g, "")])) ua = ua.replace(` ${name}/${appVersion}`, "");
  return ua.replace(/\s{2,}/g, " ");
}
