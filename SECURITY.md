# Security policy

The launcher runs a terminal on your computer and lets builderwars.ai ask it to type prompts into your AI agent, so security
reports matter a lot to us.

## Reporting a vulnerability

Report it privately through GitHub: **Security > Report a vulnerability**
(<https://github.com/rwfresh/builderwars-launcher/security/advisories/new>). Please don't open a public issue.

Include the launcher version (in the installer's file name), your platform, and the steps to reproduce. We aim to answer
within a week and will credit you in the release notes unless you'd rather we didn't.

## What we especially want to hear about

- A web page, a `builderwars://` link or another process getting a command or prompt into the terminal without the player
  pressing Run, or reaching the shell's IPC channels.
- `window.builderwarsLauncher` showing up on another origin, or a bridge call from somewhere other than the game view's top
  frame on the site origin being accepted.
- Anything of ours running in, or reading from, the X pane or a sign-in popup.
- Ways to tamper with an installed app's files or its updates.

Problems in builderwars.ai or api.builderwars.ai themselves can be reported the same way; we'll route them.

## Supported versions

Fixes go into the next release. Only the latest version at <https://builderwars.ai/download> is supported.
