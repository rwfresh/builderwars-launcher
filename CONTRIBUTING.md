# Contributing

Thanks for helping. Bug reports, platform reports and pull requests are all welcome.

## Ground rules

These keep players safe and the game fair. Pull requests that break them won't be merged.

- **The X pane is off limits.** Nothing of ours runs in x.com or reads it: no preload, no injected scripts, no DOM, cookie
  or console access, no automation. The launcher never posts, follows or acts on X for a player.
- **Prompts from outside need the player's OK.** Every prompt that comes from a web page or a `builderwars://` link goes
  through the "Run prompt?" confirmation before it reaches the terminal. Don't add a path around it.
- **Keep the sandbox.** Renderers keep `contextIsolation`, `sandbox` and no `nodeIntegration`. Every IPC handler checks its
  sender and validates its payload with zod.
- **The site bridge is a contract with the live site.** Open an issue before changing the shape or `version` of
  `window.builderwarsLauncher`.
- **Don't log secrets.** Log only the scheme and host of web-pane URLs, because full URLs can carry OAuth codes.

## Workflow

1. Fork, create a branch, then `pnpm install --frozen-lockfile` (see the README's "Build from source").
2. Make the change, with tests where it fits (vitest, `*.test.ts` next to the code).
3. `pnpm build` (typecheck + build) and `pnpm test` must pass. CI runs both on Linux, Windows and macOS.
4. Use conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`), imperative and short.
5. Open a pull request that says what changed and how you tested it (platform and steps).

Runtime testing on Windows and macOS is especially useful, since nobody has run those builds yet. `BW_DATA_ROOT=<dir>` gives
you a throwaway profile next to your real one, and `BW_AUTOTEST=1` runs the built-in self-test (see the options
table in the README).

By contributing you agree that your contributions are licensed under the Apache License 2.0 (section 5 of the
[license](LICENSE)).
