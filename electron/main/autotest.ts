// BW_AUTOTEST=1: exercise the bridge from inside the game view (our own site; never the X pane)
// once the site has loaded. Prints `[autotest] ...` lines; the shell's own autotest (src/App.tsx)
// answers the confirmation dialog (site -> Cancel).

import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type { UpdateController } from "./updater";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROBE = `
  window.__bwTest = {
    api: typeof window.builderwarsLauncher,
    launcher: typeof window.launcher,
    require: typeof window.require,
    process: typeof window.process,
    ipcRenderer: typeof window.ipcRenderer,
    origin: location.origin,
  };
  if (window.builderwarsLauncher) {
    var L = window.builderwarsLauncher;
    window.__bwTest.info = { version: L.version, agents: L.agents, defaultAgent: L.defaultAgent, herdr: L.herdr, platform: L.platform, frozen: Object.isFrozen(L) };
    L.runPrompt('   ').then(function () { window.__bwTest.emptyPrompt = 'ALLOWED (BAD)'; },
                         function (e) { window.__bwTest.emptyPrompt = 'rejected: ' + e.message; });
    L.openX('https://example.com/').then(function () { window.__bwTest.openXForeign = 'ALLOWED (BAD)'; },
                                         function (e) { window.__bwTest.openXForeign = 'rejected: ' + e.message; });
    L.openX().then(function () { window.__bwTest.openX = 'ok'; }, function (e) { window.__bwTest.openX = 'error ' + e.message; });
    L.runPrompt('hello', 'claude')
      .then(function (r) { window.__bwTest.runPrompt = 'ok ' + r.agent; },
            function (e) { window.__bwTest.runPrompt = 'error ' + e.message; });
  }
  true;
`;

async function snapshot(wc: WebContents, file: string): Promise<void> {
  try {
    const img = await wc.capturePage();
    fs.writeFileSync(file, img.toPNG());
    console.log(`[snapshot] -> ${file}`);
  } catch (e) {
    console.log(`[snapshot] failed: ${String(e)}`);
  }
}

export function autotestBridge(game: WebContents, shell: WebContents): void {
  void (async () => {
    await sleep(8000);
    if (game.isDestroyed()) return;
    await game.executeJavaScript(PROBE).catch((e: unknown) => console.log(`[autotest] probe failed: ${String(e)}`));
    await sleep(6000);
    const read = () => game.executeJavaScript("JSON.stringify(window.__bwTest)").catch((e: unknown) => `error ${String(e)}`);
    console.log(`[autotest] game bridge result ${String(await read())}`);
    // Snapshots of our own views only (shell + site); the X pane is never captured.
    const dir = process.env.BW_SNAPSHOT_DIR;
    if (dir) {
      await sleep(4000);
      await snapshot(shell, path.join(dir, "shell.png"));
      await snapshot(game, path.join(dir, "game.png"));
    }
    // The shell's autotest answers the confirmation later; read the site's result again.
    await sleep(dir ? 8000 : 12000);
    if (!game.isDestroyed()) console.log(`[autotest] game bridge result (after confirm) ${String(await read())}`);
  })();
}

/**
 * BW_AUTOTEST_POPUP=1: from our own site in the game pane, simulate a click (so the popup blocker
 * sees a user gesture), then open (a) an about:blank popup that posts a message to its opener and
 * closes itself, and (b) an accounts.google.com popup that the opener closes. Proves popups stay
 * in-app, keep window.opener, and close. Also checks that a popup without a gesture is denied.
 */
export function autotestPopup(game: WebContents, windowTitles: () => string[]): void {
  const js = `
    window.__bwPopup = {};
    window.addEventListener('message', function (e) { if (e.data === 'bw-popup-hello') window.__bwPopup.message = 'received from popup (opener works)'; });
    var w = window.open('about:blank', '_blank', 'width=500,height=600');
    window.__bwPopup.blankOpened = !!w;
    if (w) {
      w.document.write('<title>bw popup test</title><p>popup test</p><script>window.opener.postMessage("bw-popup-hello", "*"); setTimeout(function () { window.close(); }, 1500);<\\/script>');
      w.document.close();
    }
    setTimeout(function () { window.__bwPopup.blankClosedItself = w ? w.closed : null; }, 4000);
    var g = window.open('https://accounts.google.com/', '_blank', 'width=500,height=600');
    window.__bwPopup.googleOpened = !!g;
    setTimeout(function () { window.__bwPopup.googleOpenAfter5s = g ? !g.closed : null; if (g) g.close(); }, 5000);
    setTimeout(function () { window.__bwPopup.googleClosedByOpener = g ? g.closed : null; }, 7000);
    true;
  `;
  void (async () => {
    await sleep(8000);
    if (game.isDestroyed()) return;
    // Without a gesture: must be denied (window.open returns null).
    const blocked = await game.executeJavaScript("window.open('https://accounts.google.com/', '_blank', 'width=500,height=600') === null").catch(() => "error");
    console.log(`[autotest] popup without gesture blocked=${String(blocked)}`);
    // Synthetic click at the top-left corner of the page, delivered like real input.
    game.sendInputEvent({ type: "mouseDown", x: 2, y: 2, button: "left", clickCount: 1 });
    game.sendInputEvent({ type: "mouseUp", x: 2, y: 2, button: "left", clickCount: 1 });
    await sleep(200);
    await game.executeJavaScript(js, true).catch((e: unknown) => console.log(`[autotest] popup script failed: ${String(e)}`));
    await sleep(4000);
    console.log(`[autotest] popup windows at +4s: ${JSON.stringify(windowTitles())}`);
    await sleep(5000);
    console.log(`[autotest] popup windows at +9s: ${JSON.stringify(windowTitles())}`);
    const r = await game.executeJavaScript("JSON.stringify(window.__bwPopup)").catch((e: unknown) => `error ${String(e)}`);
    console.log(`[autotest] popup result ${String(r)}`);
  })();
}

/**
 * BW_AUTOTEST_UPDATE=1 or =quit (with BW_UPDATE_FEED_URL, packaged builds only): print every updater event and state
 * as `[autotest] update ...` lines, and install as soon as an update is ready. With `1`, it installs through "Restart
 * now" (quitAndInstall, the new version starts); with `quit`, through a plain quit (install on quit, nothing restarts).
 * It quits when the feed has nothing newer (which is what the relaunched, updated app sees), when a notify-mode build
 * has seen the update, or when the check fails.
 */
export function autotestUpdate(updates: UpdateController, quit: () => void, how: "restart" | "quit" = "restart"): void {
  console.log(`[autotest] update test armed: mode=${updates.mode}, install via ${how}, waiting for the scheduled check`);
  updates.subscribe((t) => {
    console.log(`[autotest] update event=${t.event} version=${t.version ?? "-"} state=${JSON.stringify(t.state)}`);
    if (t.event === "downloaded" && t.state.kind === "ready" && how === "quit") {
      console.log(`[autotest] update ready ${t.state.version}; quitting so it installs on quit`);
      setTimeout(quit, 500);
    } else if (t.event === "downloaded" && t.state.kind === "ready") {
      console.log(`[autotest] update ready ${t.state.version}; calling quitAndInstall`);
      setTimeout(() => {
        try {
          updates.restart();
        } catch (e) {
          console.log(`[autotest] update restart failed: ${e instanceof Error ? e.message : String(e)}`);
          quit();
        }
      }, 500);
    } else if (t.event === "available" && t.state.kind === "available") {
      console.log(`[autotest] update ${t.state.version} available (notify mode: no download); quitting`);
      quit();
    } else if (t.event === "not-available" || t.event === "error") {
      console.log(`[autotest] update test done (${t.event}); quitting`);
      quit();
    }
  });
}
