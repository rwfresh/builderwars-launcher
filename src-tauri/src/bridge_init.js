// Builder Wars launcher bridge. Injected ONLY into the game webview, and it does nothing unless the
// top-level document is on the configured site origin (OAuth hops through x.com in the same webview
// get nothing). Config is substituted by the launcher at startup.
(function () {
  var CFG = /*BW_CONFIG*/ null;
  if (!CFG || window.top !== window || window.location.origin !== CFG.origin) return;
  if (Object.prototype.hasOwnProperty.call(window, "builderwarsLauncher")) return;

  function toError(e) {
    if (e instanceof Error) return e;
    if (typeof e === "string") return new Error(e);
    return new Error((e && e.message) || "launcher request failed");
  }
  function invoke(cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("launcher IPC unavailable"));
    }
    return internals.invoke(cmd, args).catch(function (e) {
      throw toError(e);
    });
  }

  var api = {
    version: 1,
    platform: CFG.platform,
    agents: Object.freeze(CFG.agents.slice()),
    defaultAgent: CFG.defaultAgent,
    herdr: CFG.herdr,
    runPrompt: function (prompt, agent) {
      return invoke("run_prompt", {
        prompt: String(prompt),
        agent: agent == null ? null : String(agent),
      }).then(function (r) {
        return { agent: r.agent };
      });
    },
    openX: function (url) {
      return invoke("open_x", { url: url == null ? null : String(url) }).then(function () {});
    },
  };
  Object.defineProperty(window, "builderwarsLauncher", {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
