# AGENTS.md

Instructions for AI coding agents working in `michaeltorbert/home-screen-install`.

## GitHub identity (required)

Before any GitHub write, verify `git remote get-url origin` is
`https://github.com/michaeltorbert/home-screen-install.git`. Never use the
personal `michaeltorbert` account or a connector that would write as it. If bot
attribution cannot be guaranteed, stop and report it.

| Agent | Auth profile | Visible actor | Commit author and committer |
| --- | --- | --- | --- |
| Claude | `claude` | `claude-bot-mt[bot]` | `claude-bot-mt[bot] <275554496+claude-bot-mt[bot]@users.noreply.github.com>` |
| Codex | `games-codex` | `codex-bot-mt[bot]` | `codex-bot-mt[bot] <275535971+codex-bot-mt[bot]@users.noreply.github.com>` |

- Use `github-app-curl --profile <profile>` for API writes and the
  `git-credential-github-app <profile>` helper for pushes. Verify the live
  object's actor after each write.
- Set both author and committer explicitly to the implementing agent's bot; do
  not inherit a global Git identity.
- Every PR body has exactly one actual-author marker:
  `<!-- ai-author: claude -->`, `<!-- ai-author: codex -->` or
  `<!-- ai-author: human -->`. It names who implemented the change, not who
  opened the PR. Reviews must come from a different agent than the marker.

## Frozen runtime

`src/home-screen-install.js`, the generated `dist/` files and `demo/` are the
approved 0.1.0 component. Distribution work must not change their bytes. A
runtime change is a new version: bump `package.json`, add a `CHANGELOG.md`
section, run `npm run build`, `npm test`, the browser harness and the native
Home Screen check in `README.md`, and get it reviewed before release.

## Commands

```sh
npm run check:dist     # generated files match the source; writes nothing
npm test               # all Node suites, including distribution tooling (needs git and loopback)
npm run stage:consumer -- --target <name> --into <consumer checkout>
npm run release -- --ai-author <claude|codex|human> --dry-run|--publish
npm run update:consumers -- --dry-run|--live
npm run install:runner -- --node <abs node> --path <abs dirs>
```

See `automation/README.md` for the release, updater and launchd details.

## Boundaries

- No license has been chosen. Keep `"private": true`; do not add a license,
  publish to a registry, or add a CDN or remote loader.
- No dependencies, postinstall hooks or fetched executable code.
- The updater only opens reviewable PRs. Never add auto-merge, approval,
  deployment, secret, Actions-permission or issue-closing behavior to it.
- Do not commit local evidence, logs, status files or credentials.
