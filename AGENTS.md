# Instructions for coding agents

This is the Builder Wars desktop launcher: Electron 45, TypeScript (strict, ESM), React for the shell UI, xterm.js and
node-pty for the terminal, electron-vite and electron-builder. Read [README.md](README.md) first. It describes the process
model, the site bridge and the security model, and it is kept current.

- Layout: `electron/main` (main process), `electron/preload` (shell and game preloads), `electron/shared/contract.ts` (IPC
  channels and shared types), `src/` (shell renderer), `build/` (icons and installer resources).
- Commands: `pnpm install --frozen-lockfile`, `pnpm build` (typecheck and build), `pnpm test`. Run build and test before you
  call a change done.
- Follow the ground rules in [CONTRIBUTING.md](CONTRIBUTING.md): nothing of ours runs in or reads the X pane; site and
  deep-link prompts always need the player's confirmation; IPC handlers check their sender and validate payloads with zod;
  renderers stay sandboxed; never log full web-pane URLs.
- Don't change the shape or `version` of `window.builderwarsLauncher` without an issue: the live site depends on it.
- Update README.md in the same change when behaviour it describes changes.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
