// electron-builder afterSign hook (electron-builder.yml: `mac.notarize: false` + `afterSign`). Notarizes each signed macOS app
// with notarytool, then staples the ticket, retrying the staple: Apple's ticket service sometimes drops the connection
// ("The staple and validate action failed! Error 68"), which used to fail the whole build after Apple had already accepted
// the app (twice on Nov 5 2026). Runs only when the Apple notarization credentials are set (release builds); local and
// ad-hoc builds skip it. Never prints execFileSync's error message, which contains the command line and so the password.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const STAPLE_ATTEMPTS = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run a tool; resolves with stdout, or rejects with only its stdout/stderr (no command line). */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    const e = new Error(`${cmd} ${args[0]} exited with ${err.status ?? "an error"}: ${output.slice(-2000)}`);
    e.output = output;
    throw e;
  }
}

exports.default = async function notarizeAndStaple(context) {
  if (context.electronPlatformName !== "darwin") return;
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("  • notarize: skipped (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are not all set)");
    return;
  }
  const auth = ["--apple-id", APPLE_ID, "--password", APPLE_APP_SPECIFIC_PASSWORD, "--team-id", APPLE_TEAM_ID];
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const label = path.relative(process.cwd(), appPath);
  const zipPath = `${appPath}.notarize.zip`;

  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
  let result;
  try {
    console.log(`  • notarize: submitting ${label} and waiting for Apple`);
    let out;
    try {
      out = run("xcrun", ["notarytool", "submit", zipPath, ...auth, "--wait", "--output-format", "json"]);
    } catch (err) {
      out = err.output ?? "";
    }
    try {
      result = JSON.parse(out.trim().split("\n").pop() ?? "");
    } catch {
      throw new Error(`notarytool returned no result: ${out.slice(-2000)}`);
    }
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
  if (result.status !== "Accepted") {
    let log = "";
    if (result.id) {
      try {
        log = run("xcrun", ["notarytool", "log", result.id, ...auth]);
      } catch (err) {
        log = err.output ?? "";
      }
    }
    throw new Error(`notarization of ${label} ended with status ${result.status ?? "unknown"} (submission ${result.id ?? "?"}): ${log.slice(0, 4000)}`);
  }
  console.log(`  • notarize: accepted ${label} (submission ${result.id})`);

  for (let attempt = 1; ; attempt++) {
    try {
      run("xcrun", ["stapler", "staple", appPath]);
      console.log(`  • staple: ${label} stapled (attempt ${attempt})`);
      return;
    } catch (err) {
      const tail = (err.output ?? "").split("\n").filter(Boolean).slice(-2).join(" | ");
      if (attempt >= STAPLE_ATTEMPTS) throw new Error(`stapling ${label} failed ${attempt} times: ${tail}`);
      const waitMs = attempt * 20_000;
      console.log(`  • staple: attempt ${attempt} for ${label} failed (${tail}); retrying in ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
};
