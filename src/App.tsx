import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { AGENT_LABELS, buildCommand, chooseAgent, isAgentId, shellKindFromPath, type AgentId } from "./agents";
import { isXUrl, paneLoadSchema, paneTitleSchema, parseDeepLinkRequests, parseRunPromptEvent, parseSiteUrl } from "./bridge";
import { SHELL_EVENTS } from "../electron/shared/contract";
import { ChildPanePlaceholder } from "./ChildPane";
import {
  bridgeResolve,
  debugLog,
  deeplinkTake,
  herdrDispatch,
  launcherInfo,
  onLauncherEvent,
  paneFocus,
  paneNav,
  pickWorkDir,
  saveSettings,
  updateCheck,
  updateOpenDownload,
  updateRestart,
  type ChildPane,
  type LauncherInfo,
  type Settings,
  type UpdateState,
} from "./ipc";
import {
  IconBack,
  IconCollapseLeft,
  IconCollapseRight,
  IconCycle,
  IconFolder,
  IconHome,
  IconReload,
  IconSend,
  IconSettings,
  IconTerminal,
} from "./icons";
import { DEFAULT_LAYOUT, DIVIDER_PX, computeColumns, dragDivider, nextFocus, toggleCollapsed, type LayoutState, type PaneId } from "./layout";
import { Terminal, type TerminalHandle } from "./Terminal";
import { THEME_IDS, THEME_LABELS, isThemeId } from "./themes";
import { parseUpdateState, UPDATE_MODE_LABELS, updateBanner, type UpdateAction } from "./update";

interface PaneInfo {
  url: string;
  title: string;
  loading: boolean;
}

const X_HOME = "https://x.com/home";

/** A prompt waiting for the player's OK (from the site bridge or a builderwars:// link). */
interface PendingRun {
  key: number;
  source: "site" | "deeplink";
  agent: AgentId;
  prompt: string;
  /** run_prompt request id to answer (site only). */
  bridgeId?: number;
}

let pendingKey = 0;

/** Show a path with ~ for the home directory. */
function tildify(path: string, home: string): string {
  const h = home.replace(/[\\/]+$/, "");
  return path === h ? "~" : path.startsWith(h + "/") || path.startsWith(h + "\\") ? `~${path.slice(h.length)}` : path;
}

export function App() {
  const [info, setInfo] = useState<LauncherInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    launcherInfo().then(setInfo, (e: unknown) => setError(String(e)));
  }, []);
  if (error) return <div className="boot err">Launcher error: {error}</div>;
  if (!info) return <div className="boot">Starting Builder Wars…</div>;
  return <Shell info={info} />;
}

function Shell({ info }: { info: LauncherInfo }) {
  const { env } = info;
  const [settings, setSettings] = useState<Settings>(info.settings);
  const useHerdr = env.herdr && (settings.useHerdr ?? true);
  const shellKind = shellKindFromPath(env.shell);
  const [layout, setLayout] = useState<LayoutState>(DEFAULT_LAYOUT);
  const [width, setWidth] = useState(window.innerWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<string>("ready");
  const [focused, setFocused] = useState<PaneId>("terminal");
  const [panes, setPanes] = useState<Record<ChildPane, PaneInfo>>({
    game: { url: info.siteUrl, title: "", loading: true },
    xpane: { url: X_HOME, title: "", loading: true },
  });
  const [xMode, setXMode] = useState<"home" | "grok">("home");
  const [manualPrompt, setManualPrompt] = useState("");
  const [workDir, setWorkDir] = useState(info.workDir);
  const [queue, setQueue] = useState<PendingRun[]>([]);
  const [allowSiteSession, setAllowSiteSession] = useState(false);
  const [update, setUpdate] = useState<UpdateState>(info.updates.state);
  const siteHost = new URL(info.siteUrl).host;
  const confirm = queue[0] ?? null;
  const term = useRef<TerminalHandle>(null);
  const defaultAgent = chooseAgent(null, settings.defaultAgent, env.agents);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cols = computeColumns(width, layout);

  /** Core action: run an agent with an initial prompt in the terminal pane. Returns the agent used. */
  const runPrompt = useCallback(
    async ({ agent, prompt }: { agent?: string | null; prompt: string }): Promise<string> => {
      const choice = chooseAgent(agent, settings.defaultAgent, env.agents);
      if ("error" in choice) throw new Error(choice.error);
      const line = buildCommand(choice.agent, prompt, shellKind, { cwd: workDir, home: info.home });
      if (useHerdr) {
        const r = await herdrDispatch(line);
        setStatus(`${AGENT_LABELS[choice.agent]} started in herdr pane ${r.paneId}${r.split ? " (new split)" : ""}`);
      } else {
        const t = term.current;
        void debugLog(`runPrompt agent=${choice.agent} herdr=${useHerdr} handle=${t ? "yes" : "no"}`);
        if (!t) throw new Error("terminal not ready");
        if (!(await t.isIdle())) throw new Error("the terminal is busy; exit the running program first");
        await t.type(line);
        setStatus(`${AGENT_LABELS[choice.agent]} started in the terminal`);
      }
      setLayout((l) => toggleCollapsed(l, "terminal", false));
      return choice.agent;
    },
    [settings.defaultAgent, env.agents, shellKind, useHerdr, workDir, info.home],
  );

  /** Run a confirmed request and answer the site if it came from the bridge. */
  const execute = useCallback(
    (req: PendingRun) => {
      runPrompt({ agent: req.agent, prompt: req.prompt }).then(
        (agent) => (req.bridgeId != null ? bridgeResolve(req.bridgeId, true, agent) : undefined),
        (e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          setStatus(`run prompt failed: ${msg}`);
          return req.bridgeId != null ? bridgeResolve(req.bridgeId, false, msg) : undefined;
        },
      );
    },
    [runPrompt],
  );

  const decide = useCallback(
    (req: PendingRun, run: boolean, alwaysAllowSite = false) => {
      setQueue((q) => q.filter((r) => r.key !== req.key));
      if (alwaysAllowSite && req.source === "site") setAllowSiteSession(true);
      if (run) {
        execute(req);
      } else {
        setStatus("prompt cancelled");
        if (req.bridgeId != null) void bridgeResolve(req.bridgeId, false, "Cancelled");
      }
    },
    [execute],
  );

  /** Queue a request from outside the shell UI; it runs only after confirmation. */
  const enqueue = useCallback(
    (source: PendingRun["source"], prompt: string, requested: string | null | undefined, bridgeId?: number) => {
      const choice = chooseAgent(requested, settings.defaultAgent, env.agents);
      if ("error" in choice) {
        setStatus(`run prompt failed: ${choice.error}`);
        if (bridgeId != null) void bridgeResolve(bridgeId, false, choice.error);
        return;
      }
      const req: PendingRun = { key: ++pendingKey, source, agent: choice.agent, prompt, ...(bridgeId != null ? { bridgeId } : {}) };
      if (source === "site" && allowSiteSession) {
        execute(req);
        return;
      }
      setQueue((q) => [...q, req]);
      setSettingsOpen(false);
      setLayout((l) => toggleCollapsed(l, "terminal", false));
      setStatus(source === "site" ? `${siteHost} wants to run a prompt; confirm in the terminal pane` : "a builderwars:// link wants to run a prompt; confirm in the terminal pane");
      void debugLog(`confirm queued source=${source} agent=${choice.agent} chars=${prompt.length}`);
    },
    [settings.defaultAgent, env.agents, allowSiteSession, execute, siteHost],
  );

  const focusPane = useCallback((p: PaneId) => {
    setFocused(p);
    if (p === "terminal") {
      void paneFocus("terminal").then(() => term.current?.focus());
    } else {
      void paneFocus(p);
    }
  }, []);

  // Bridge + pane events from the main process.
  const enqueueRef = useRef(enqueue);
  enqueueRef.current = enqueue;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    const unsubs = [
      onLauncherEvent(SHELL_EVENTS.bridgeRunPrompt, (payload) => {
        const req = parseRunPromptEvent(payload);
        if (!req) return;
        enqueueRef.current("site", req.prompt, req.agent ?? null, req.id);
      }),
      onLauncherEvent(SHELL_EVENTS.bridgeExpired, (id) => {
        setQueue((q) => q.filter((r) => r.bridgeId !== id));
      }),
      onLauncherEvent(SHELL_EVENTS.deeplinkPending, () => {
        void deeplinkTake().then((reqs) =>
          parseDeepLinkRequests(reqs).forEach((r) => enqueueRef.current("deeplink", r.prompt, r.agent ?? null)),
        );
      }),
      onLauncherEvent(SHELL_EVENTS.notice, (msg) => setStatus(String(msg))),
      onLauncherEvent(SHELL_EVENTS.updateState, (payload) => {
        const s = parseUpdateState(payload);
        if (s) setUpdate(s);
      }),
      onLauncherEvent(SHELL_EVENTS.paneLoad, (payload) => {
        const p = paneLoadSchema.safeParse(payload);
        if (!p.success) return;
        setPanes((s) => ({ ...s, [p.data.pane]: { ...s[p.data.pane], url: p.data.url, loading: p.data.phase === "started" } }));
      }),
      onLauncherEvent(SHELL_EVENTS.paneTitle, (payload) => {
        const p = paneTitleSchema.safeParse(payload);
        if (!p.success) return;
        setPanes((s) => ({ ...s, [p.data.pane]: { ...s[p.data.pane], title: p.data.title } }));
      }),
      onLauncherEvent(SHELL_EVENTS.paneReveal, () => setLayout((l) => toggleCollapsed(l, "xpane", false))),
      onLauncherEvent(SHELL_EVENTS.focusCycle, () => focusPane(nextFocus(focusedRef.current, layoutRef.current.collapsed))),
    ];
    // Links that arrived before we listened (cold start from a builderwars:// link).
    void deeplinkTake().then((reqs) =>
      parseDeepLinkRequests(reqs).forEach((r) => enqueueRef.current("deeplink", r.prompt, r.agent ?? null)),
    );
    return () => unsubs.forEach((u) => u());
  }, [focusPane]);

  // Autotest: answer confirmations by themselves (site -> Cancel, deep link -> Run), late enough
  // for the main process to snapshot the dialog first.
  useEffect(() => {
    if (!info.autotest || !confirm) return;
    const t = setTimeout(() => {
      void debugLog(`autotest: ${confirm.source === "site" ? "cancel" : "run"} confirmation from ${confirm.source}`);
      decide(confirm, confirm.source !== "site");
    }, 14000);
    return () => clearTimeout(t);
  }, [info.autotest, confirm, decide]);

  // F6 / Ctrl+` cycle focus. The main process catches F6 in every pane (before-input-event, so it
  // also works while a web pane has keyboard focus) and emits focus:cycle; Ctrl+` is handled here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        focusPane(nextFocus(focusedRef.current, layoutRef.current.collapsed));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusPane]);

  // Autotest: show the PTY works with a real agent CLI (main drives the bridge test separately).
  useEffect(() => {
    if (!info.autotest) return;
    const t = setTimeout(() => {
      const line = "claude --version";
      if (useHerdr) void herdrDispatch(line).then((r) => setStatus(`autotest: ${line} in ${r.paneId}`));
      else {
        void debugLog(`autotest: handle=${term.current ? "yes" : "no"}`);
        void term.current?.type(line).then(
          () => setStatus(`autotest: typed ${line}`),
          (e: unknown) => void debugLog(`autotest type failed: ${String(e)}`),
        );
      }
    }, 3000);
    // Layout exercise: drag the first divider, collapse and re-expand the X pane. The pane view
    // bounds that follow are visible in the launcher log (BW_DEBUG_BOUNDS=1).
    const steps = [
      setTimeout(() => {
        void debugLog("autotest: drag divider 1 by +60px");
        setLayout((l) => dragDivider(l, 1, 60, window.innerWidth));
      }, 22000),
      setTimeout(() => {
        void debugLog("autotest: collapse X");
        setLayout((l) => toggleCollapsed(l, "xpane", true));
      }, 24000),
      setTimeout(() => {
        void debugLog("autotest: expand X");
        setLayout((l) => toggleCollapsed(l, "xpane", false));
      }, 26000),
    ];
    return () => {
      clearTimeout(t);
      steps.forEach(clearTimeout);
    };
  }, [info.autotest, useHerdr]);

  // Divider drag.
  const drag = useRef<{ divider: 0 | 1; startX: number; start: LayoutState } | null>(null);
  const onDividerDown = (divider: 0 | 1) => (e: RPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { divider, startX: e.clientX, start: layout };
    document.body.classList.add("dragging");
  };
  const onDividerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setLayout(dragDivider(d.start, d.divider, e.clientX - d.startX, width));
  };
  const onDividerUp = () => {
    drag.current = null;
    document.body.classList.remove("dragging");
  };

  const collapse = (p: PaneId) => setLayout((l) => toggleCollapsed(l, p));
  const xTarget = xMode === "grok" ? settings.grokUrl : X_HOME;
  const toggleXMode = () => {
    const next = xMode === "home" ? "grok" : "home";
    setXMode(next);
    void paneNav("xpane", "go", next === "grok" ? settings.grokUrl : X_HOME);
  };

  const gridTemplate = `${cols.terminal}px ${DIVIDER_PX}px ${cols.game}px ${DIVIDER_PX}px ${cols.xpane}px`;
  const shortUrl = (u: string) => u.replace(/^https?:\/\//, "").slice(0, 80);

  return (
    <div className="shell" style={{ gridTemplateColumns: gridTemplate }}>
      {/* LEFT: terminal + toolbar */}
      {layout.collapsed.terminal ? (
        <CollapsedStrip label="Terminal" onExpand={() => collapse("terminal")} />
      ) : (
        <section className={`col col-left ${focused === "terminal" ? "focused" : ""}`} aria-label="Terminal">
          <header className="pane-head">
            <div className="pane-heading">
              <span className="pane-name">Terminal</span>
              <span className="pane-title">{useHerdr ? "herdr · session builderwars" : env.shell}</span>
            </div>
            <button className="icon-btn" title="Collapse terminal" aria-label="Collapse terminal" onClick={() => collapse("terminal")}>
              <IconCollapseLeft />
            </button>
          </header>
          <div className="term-wrap">
            <Terminal
              ref={term}
              mode={useHerdr ? "herdr" : "shell"}
              theme={settings.theme}
              visible={!settingsOpen && !confirm}
              onFocus={() => setFocused("terminal")}
            />
            {confirm && (
              <ConfirmPanel
                key={confirm.key}
                req={confirm}
                siteHost={siteHost}
                workDir={tildify(workDir, info.home)}
                queued={queue.length - 1}
                onDecide={(run, always) => decide(confirm, run, always)}
              />
            )}
            {settingsOpen && !confirm && (
              <SettingsPanel
                info={info}
                settings={settings}
                updateBusy={update.kind === "checking"}
                onCheckUpdates={() => void updateCheck().catch((e: unknown) => setStatus(`update check failed: ${e instanceof Error ? e.message : String(e)}`))}
                onClose={() => setSettingsOpen(false)}
                onSave={async (s) => {
                  await saveSettings(s);
                  const siteChanged = s.siteUrl !== settings.siteUrl;
                  setSettings(s);
                  const fresh = await launcherInfo();
                  setWorkDir(fresh.workDir);
                  setSettingsOpen(false);
                  setStatus(siteChanged ? "saved; restart the launcher to use the new site URL" : "settings saved");
                }}
              />
            )}
          </div>
          <footer className="toolbar">
            <div className="row">
              <label className="field">
                Agent
                <select
                  value={"agent" in defaultAgent ? defaultAgent.agent : ""}
                  onChange={(e) => {
                    const s = { ...settings, defaultAgent: e.target.value || null };
                    setSettings(s);
                    void saveSettings(s);
                  }}
                >
                  {env.agents.length === 0 && <option value="">none found</option>}
                  {env.agents.filter(isAgentId).map((a) => (
                    <option key={a} value={a}>
                      {AGENT_LABELS[a]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`field check ${env.herdr ? "" : "disabled"}`} title={env.herdr ? "Run the terminal inside herdr" : "herdr not found on PATH"}>
                <input
                  type="checkbox"
                  disabled={!env.herdr}
                  checked={useHerdr}
                  onChange={(e) => {
                    const s = { ...settings, useHerdr: e.target.checked };
                    setSettings(s);
                    void saveSettings(s);
                  }}
                />
                herdr
              </label>
              <span className="spacer" />
              <button
                className="icon-btn"
                title={settingsOpen ? "Close settings" : "Settings"}
                aria-label="Settings"
                aria-pressed={settingsOpen}
                onClick={() => setSettingsOpen((o) => !o)}
              >
                <IconSettings />
              </button>
              <button
                className="icon-btn"
                title="Cycle focus (F6)"
                aria-label="Cycle focus (F6)"
                onClick={() => focusPane(nextFocus(focused, layout.collapsed))}
              >
                <IconCycle />
              </button>
            </div>
            <div className="row">
              <span className="field dir-field" title={workDir}>
                <IconFolder />
                <span className="dir">{tildify(workDir, info.home)}</span>
              </span>
              <button
                className="btn small"
                title="Directory your agents start in"
                onClick={() =>
                  pickWorkDir().then(
                    (d) => {
                      if (d) {
                        setWorkDir(d);
                        setSettings((s) => ({ ...s, workDir: d }));
                        setStatus(`agents now start in ${tildify(d, info.home)}`);
                      }
                    },
                    (e: unknown) => setStatus(`error: ${String(e)}`),
                  )
                }
              >
                Change
              </button>
            </div>
            <form
              className="prompt-box"
              onSubmit={(e) => {
                e.preventDefault();
                if (!manualPrompt.trim()) return;
                runPrompt({ prompt: manualPrompt }).then(
                  () => setManualPrompt(""),
                  (err: unknown) => setStatus(`error: ${err instanceof Error ? err.message : String(err)}`),
                );
              }}
            >
              <input
                className="prompt"
                placeholder="Prompt your agent…"
                aria-label="Prompt for your agent"
                value={manualPrompt}
                onChange={(e) => setManualPrompt(e.target.value)}
              />
              <button className="send" type="submit" title="Run in the terminal" aria-label="Run prompt" disabled={!manualPrompt.trim()}>
                <IconSend />
              </button>
            </form>
            <UpdateBar state={update} onError={(msg) => setStatus(`update: ${msg}`)} />
            <div className="status" title={status} role="status">
              <span className="status-dot" aria-hidden="true" />
              <span className="status-text">{status}</span>
            </div>
          </footer>
        </section>
      )}

      <div className="divider" onPointerDown={onDividerDown(0)} onPointerMove={onDividerMove} onPointerUp={onDividerUp} />

      {/* CENTER: game pane (WebContentsView) */}
      {layout.collapsed.game ? (
        <CollapsedStrip label="Game" onExpand={() => collapse("game")} />
      ) : (
        <section className={`col ${focused === "game" ? "focused" : ""}`} aria-label="Game">
          <header className="pane-head">
            <div className="pane-heading">
              <span className="pane-name">Game</span>
              <span className="pane-title" title={panes.game.url}>
                {panes.game.loading ? "Loading… " : ""}
                {panes.game.title || shortUrl(panes.game.url)}
              </span>
            </div>
            <button className="icon-btn" title="Back" aria-label="Back" onClick={() => void paneNav("game", "back")}>
              <IconBack />
            </button>
            <button className="icon-btn" title="Reload" aria-label="Reload" onClick={() => void paneNav("game", "reload")}>
              <IconReload />
            </button>
            <button
              className="icon-btn"
              title={`Home: back to ${siteHost}`}
              aria-label={`Home: back to ${siteHost}`}
              onClick={() => void paneNav("game", "go", `${info.siteOrigin}/`)}
            >
              <IconHome />
            </button>
            <button className="icon-btn" title="Collapse game" aria-label="Collapse game" onClick={() => collapse("game")}>
              <IconCollapseRight />
            </button>
          </header>
          <ChildPanePlaceholder pane="game" label="builderwars.ai" visible={!layout.collapsed.game} />
        </section>
      )}

      <div className="divider" onPointerDown={onDividerDown(1)} onPointerMove={onDividerMove} onPointerUp={onDividerUp} />

      {/* RIGHT: X pane (WebContentsView) */}
      {layout.collapsed.xpane ? (
        <CollapsedStrip label="X" onExpand={() => collapse("xpane")} />
      ) : (
        <section className={`col ${focused === "xpane" ? "focused" : ""}`} aria-label="X">
          <header className="pane-head">
            <div className="pane-heading">
              <span className="pane-name">X</span>
              <span className="pane-title" title={panes.xpane.url}>
                {panes.xpane.loading ? "Loading… " : ""}
                {panes.xpane.title || shortUrl(panes.xpane.url || xTarget)}
              </span>
            </div>
            <button className="icon-btn" title="Back" aria-label="Back" onClick={() => void paneNav("xpane", "back")}>
              <IconBack />
            </button>
            <button className="icon-btn" title="Reload" aria-label="Reload" onClick={() => void paneNav("xpane", "reload")}>
              <IconReload />
            </button>
            <button className="btn small" title={`Switch to ${xMode === "home" ? "Grok" : "Home"}`} onClick={toggleXMode}>
              {xMode === "home" ? "Grok" : "Home"}
            </button>
            <button className="icon-btn" title="Collapse X" aria-label="Collapse X" onClick={() => collapse("xpane")}>
              <IconCollapseRight />
            </button>
          </header>
          <ChildPanePlaceholder pane="xpane" label="x.com" visible={!layout.collapsed.xpane} />
        </section>
      )}
    </div>
  );
}

function CollapsedStrip({ label, onExpand }: { label: string; onExpand: () => void }) {
  return (
    <button className="strip" onClick={onExpand} title={`Expand ${label}`}>
      <span>{label}</span>
    </button>
  );
}

/** Update banner above the status line (states from electron/main/updater.ts). */
function UpdateBar({ state, onError }: { state: UpdateState; onError: (msg: string) => void }) {
  // LATER hides a ready update until the next launch (auto mode installs it on quit anyway); OK closes feedback.
  const [laterVersion, setLaterVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<UpdateState | null>(null);
  const banner = updateBanner(state, laterVersion, dismissed);
  if (!banner) return null;
  const fail = (e: unknown) => onError(e instanceof Error ? e.message : String(e));
  const run: Record<UpdateAction, () => void> = {
    restart: () => void updateRestart().catch(fail),
    later: () => setLaterVersion(state.kind === "ready" ? state.version : null),
    download: () => void updateOpenDownload().catch(fail),
    dismiss: () => setDismissed(state),
  };
  const labels: Record<UpdateAction, string> = { restart: "Restart now", later: "Later", download: "Download", dismiss: "OK" };
  return (
    <div className={`update-bar ${banner.subtle ? "subtle" : ""}`} role="status">
      <span className="update-text" title={banner.text}>
        {banner.text}
      </span>
      {banner.actions.map((a) => (
        <button key={a} className={`btn small ${a === "restart" || a === "download" ? "primary" : ""}`} onClick={run[a]}>
          {labels[a]}
        </button>
      ))}
    </div>
  );
}

function SettingsPanel({
  info,
  settings,
  updateBusy,
  onCheckUpdates,
  onSave,
  onClose,
}: {
  info: LauncherInfo;
  settings: Settings;
  updateBusy: boolean;
  onCheckUpdates: () => void;
  onSave: (s: Settings) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [err, setErr] = useState<string | null>(null);
  const herdrValue = draft.useHerdr == null ? "auto" : draft.useHerdr ? "on" : "off";
  const valid = useMemo(() => {
    if (!parseSiteUrl(draft.siteUrl)) return "site URL must be http(s)";
    if (!isXUrl(draft.grokUrl)) return "Grok URL must be an https://x.com URL";
    return null;
  }, [draft]);
  return (
    <div className="settings">
      <h2>Settings</h2>
      <label>
        Theme
        <select value={draft.theme} onChange={(e) => isThemeId(e.target.value) && setDraft({ ...draft, theme: e.target.value })}>
          {THEME_IDS.map((t) => (
            <option key={t} value={t}>
              {THEME_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Default agent
        <select value={draft.defaultAgent ?? ""} onChange={(e) => setDraft({ ...draft, defaultAgent: e.target.value || null })}>
          <option value="">first installed</option>
          {info.env.agents.filter(isAgentId).map((a) => (
            <option key={a} value={a}>
              {AGENT_LABELS[a]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Use herdr {info.env.herdr ? "" : "(not installed)"}
        <select
          value={herdrValue}
          disabled={!info.env.herdr}
          onChange={(e) => setDraft({ ...draft, useHerdr: e.target.value === "auto" ? null : e.target.value === "on" })}
        >
          <option value="auto">auto (on when installed)</option>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>
      </label>
      <label>
        Work directory (agents start here; empty = ~/BuilderWars)
        <input
          value={draft.workDir ?? ""}
          placeholder="~/BuilderWars"
          onChange={(e) => setDraft({ ...draft, workDir: e.target.value.trim() === "" ? null : e.target.value })}
        />
      </label>
      <label>
        Grok chat URL
        <input value={draft.grokUrl} onChange={(e) => setDraft({ ...draft, grokUrl: e.target.value })} />
      </label>
      <label>
        Game site URL (restart to apply; bridge only trusts this origin)
        <input value={draft.siteUrl} onChange={(e) => setDraft({ ...draft, siteUrl: e.target.value })} />
      </label>
      <div className="settings-section">
        <span>
          Builder Wars {info.version} · updates {UPDATE_MODE_LABELS[info.updates.mode]}
        </span>
        <button className="btn small" disabled={info.updates.mode === "off" || updateBusy} onClick={onCheckUpdates}>
          Check for updates
        </button>
      </div>
      <p className="muted">
        Active site: {info.siteUrl} · agents on PATH: {info.env.agents.join(", ") || "none"} · shell: {info.env.shell}
      </p>
      {(err ?? valid) && <p className="err">{err ?? valid}</p>}
      <div className="row actions">
        <button
          className="btn primary"
          disabled={valid != null}
          onClick={() => onSave(draft).catch((e: unknown) => setErr(String(e)))}
        >
          Save
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConfirmPanel({
  req,
  siteHost,
  workDir,
  queued,
  onDecide,
}: {
  req: PendingRun;
  siteHost: string;
  workDir: string;
  queued: number;
  onDecide: (run: boolean, alwaysAllowSite: boolean) => void;
}) {
  const [always, setAlways] = useState(false);
  const runRef = useRef<HTMLButtonElement>(null);
  useEffect(() => runRef.current?.focus(), []);
  return (
    <div className="settings confirm" role="alertdialog" aria-label="Run prompt?">
      <h2>
        <IconTerminal />
        Run prompt?
      </h2>
      <p className="muted">
        {req.source === "site" ? (
          <>
            <b className="strong">{siteHost}</b> asks to start an agent in your terminal.
          </>
        ) : (
          <>
            A <b className="strong">builderwars://</b> link (opened by a web page or another app) asks to start an agent in your
            terminal.
          </>
        )}
      </p>
      <p className="facts">
        <span>
          Agent <b>{AGENT_LABELS[req.agent]}</b>
        </span>
        <span>
          Folder <b>{workDir}</b>
        </span>
        {queued > 0 ? <span>{queued} more waiting</span> : null}
      </p>
      <pre className="prompt-text">{req.prompt}</pre>
      {req.source === "site" && (
        <label className="check-row">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          Always allow prompts from {siteHost} this session
        </label>
      )}
      <div className="row">
        <button ref={runRef} className="btn primary" onClick={() => onDecide(true, always)}>
          Run
        </button>
        <button className="btn" onClick={() => onDecide(false, false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
