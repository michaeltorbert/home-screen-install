# Distribution automation

How releases reach the four consumer repositories. Everything here is local
operator tooling. Nothing runs on GitHub-hosted infrastructure except the
read-only checks.

## Operating limit

The updater is a **per-user launchd job on one Mac**. It runs daily only while
that Mac is powered on and the user is logged in. If the Mac is asleep at the
scheduled time, launchd runs the job at the next wake. If the Mac is off or
logged out, nothing runs, and nothing on GitHub reports the missed run. The
local status file is the record; check its `finishedAt` date. This is not
always-on hosted automation.

## Pieces

| Path | Role |
| --- | --- |
| `distribution/consumers.json` | Allowed targets: repository, vendor path, format, App profile and actor, commit identity, pre-commit checks, covered apps and issues |
| `distribution/templates/check-home-screen-install.mjs` | Offline verifier. Copied byte-for-byte to each consumer as `.github/scripts/check-home-screen-install.mjs` |
| `distribution/templates/home-screen-install.yml` | Consumer read-only PR/push check. Copied byte-for-byte to `.github/workflows/home-screen-install.yml` |
| `scripts/stage-consumer.mjs` | Writes one consumer's vendor payload from this checkout's clean HEAD (bootstrap) |
| `scripts/release.mjs` | Publishes the GitHub release for the current version |
| `scripts/update-consumers.mjs` | Proposes newer releases to consumers as PRs |
| `scripts/install-runner.mjs` | Installs a pinned updater copy and writes its LaunchAgent plist |
| `automation/home-screen-install-updater.plist.template` | LaunchAgent template; holds no credentials or key paths |

### Vendored payload

Each consumer has exactly three files in its vendor directory:

- the selected script (`home-screen-install.js` classic or `home-screen-install.mjs` ESM);
- the release's complete `SHA256SUMS`, which lists both formats; only the selected entry is checked;
- `home-screen-install.lock.json`, which records the package, source, version, tag, full source commit, format, file and script SHA-256.

The updater writes only these files. It never runs code fetched from the source
or consumer repositories. It verifies payloads in-process with the installed
runner's own pinned checker. It only compares the consumer's checker with that
reviewed file, so the consumer's CI agrees; a different checker is refused
(`checker-mismatch`) and never executed. The consumer checker and workflow
change only through a reviewed PR in that consumer.

| Repository | Vendor directory | Format | Adoption issues |
| --- | --- | --- | --- |
| games | `shared/home-screen-install/` | classic | #193 Football, #194 Place by Place, #195 Kayak |
| math-connections | `src/vendor/home-screen-install/` | ESM | #4 |
| homecall | `src/vendor/home-screen-install/` | ESM | #52 |
| sportsapp | `src/vendor/home-screen-install/` | ESM | #169 |

## Bootstrap (first setup)

1. Commit the reviewed source tree. Do not create a tag yet.
2. For each consumer checkout on `setup/home-screen-install`, which already has
   the checker, workflow, package script and docs:
   ```sh
   node scripts/stage-consumer.mjs --target games --into /path/to/games
   ```
   The command refuses a dirty source checkout, stale `dist/`, a wrong consumer
   origin, a checker that differs from the template, or unexpected files in the
   vendor directory. The lock records the source HEAD commit that will become
   the release tag.
3. Run `npm run check:home-screen-install` in each consumer, then commit with
   that repository's identity and open the four setup PRs.
4. After the source commit is pushed and its checks pass, publish the release
   from that same commit (below). The updater later derives byte-identical
   payloads from the published release.

A consumer whose default branch has no lock yet is reported as
`pending-bootstrap-merge` and skipped. The updater never creates setup PRs.

## Release

From a clean checkout whose HEAD is the pushed `main`, with a `CHANGELOG.md`
heading `## <version>`:

```sh
node scripts/release.mjs --ai-author claude --dry-run    # verifies and prints the asset hashes
node scripts/release.mjs --ai-author claude --publish
```

`--ai-author` records who actually implemented the release. Updater PRs copy it
into their single `ai-author` marker, and a release without a valid value is
refused. Commits use the identity that each target's `commitIdentities` maps
that author to:

- games and math-connections: the prescribed shared local identity, for
  `claude` and `codex`;
- homecall and sportsapp: the implementing AI's own bot, which is configured
  only for `claude`.

An author with no mapping (any `human` release, or a `codex` release for
homecall or sportsapp) is refused as `unsupported-author` before any write.
Supporting it is a deliberate, reviewed `consumers.json` change and runner
reinstall.

The publisher first confirms the `claude` profile's App slug. It then pushes the
`v<version>` tag and creates a draft release. It uploads
`home-screen-install.js`, `home-screen-install.mjs`, `SHA256SUMS` and
`release-manifest.json`. It checks each draft asset's state, size and GitHub's
`digest` (`sha256:…`) against the local bytes, and only then publishes. A
missing digest fails closed. After publishing, it downloads every public asset
anonymously and compares the bytes.

The tag push and the publisher's `ls-remote` checks do not trust the checkout's
git configuration to choose credentials:

- They use the explicit `https://github.com/michaeltorbert/home-screen-install.git`
  URL, never the `origin` remote.
- They run with system and global config disabled, and with inherited
  `GIT_CONFIG_*`, `GIT_ASKPASS` and `SSH_ASKPASS` removed.
- Command-line resets clear every repository credential helper, both plain and
  `credential.https://github.com.helper`, and every `http.<url>.extraHeader`.
  Only `git-credential-github-app <source.profile>` (the `claude` profile) is
  then added, found on `PATH`. Askpass and hooks are disabled.
- Before any remote access, the publisher refuses repository config that could
  still reroute traffic: any `credential.*` key other than `credential.helper`
  or `credential.https://github.com.helper`, any `http.*` key, and any `url.*`
  rewrite. Includes are followed. Remove such keys from the checkout first.

The App wrapper already sends the `Accept`, `Authorization` and
`X-GitHub-Api-Version` headers. The tooling adds none of them, since duplicate
headers can be rejected with HTTP 400, and it makes only JSON API calls through
the wrapper. All binary downloads use public URLs without credentials.

It refuses to move an existing tag, overwrite a published release, or reuse an
existing draft. If it fails after creating the draft, it leaves an unpublished
draft and reports its id. Drafts are never consumed. Inspect and delete the
draft before retrying.

GitHub release assets and tags can still be edited by repository admins. They
are not described as immutable unless the API reports `immutable: true`; the
publisher prints that field. Consumers detect later drift instead: the lock
records the full commit and script hash, and the updater refuses a release
whose tag, manifest, assets and tagged tree disagree.

## Updater

```sh
node scripts/update-consumers.mjs --dry-run            # read-only, including App preflight
node scripts/update-consumers.mjs --live [--target games] [--release v0.1.1]
```

For each target, in a fresh temporary clone of the default branch:

1. The App profile's slug must match the map. Each profile is checked once per run.
2. No lock means `pending-bootstrap-merge`. A vendor directory that fails the
   checker means `vendor-invalid`, which covers hand edits.
3. The candidate is the newest published, non-draft, non-prerelease
   `vX.Y.Z` release on the same compatibility line: same major, and same minor
   for `0.x`. The API's `latest` flag is not used. A newer release on another
   line is reported as `newerLine` and needs an explicit `--release`.
4. Verification checks that the release was published by an allowed App, that
   the assets are exactly the four expected files, and that the manifest
   hashes, the peeled tag commit and the tagged tree's `package.json` and
   `dist/` bytes all agree.
5. If the release matches the lock, the result is `up-to-date`, provided the
   bytes are identical. A different commit is `moved-tag`; different bytes are
   `vendor-drift`. An older release is `downgrade-refused`.
6. The branch is `home-screen-install/v<version>`. The updater never
   force-pushes, resets or reopens:
   - **Owned branch, matching open PR:** `pr-open` (no write).
   - **Owned branch, no PR:** the missing PR is opened (`pr-opened-resumed`).
   - **Foreign commits or different content on the branch:** `branch-conflict`.
   - **A closed PR for the branch:** `closed-pr-exists`.
   - **No branch:** one commit, then a push and a new PR (`pr-opened`).
7. Before committing, the updater verifies the payload with its pinned checker
   and runs the target's pre-commit scripts. Today that is only Math
   Connections' `scripts/git-safety-check.sh`, pinned in `consumers.json` by
   its reviewed sha256. Immediately before every run, the script's bytes in the
   temporary checkout must match that hash. It then runs with `/bin/sh`;
   otherwise it is refused (`pre-commit-mismatch`) and not executed. The safety
   check runs again before the push and PR. If the script changes on `main`,
   updates for that repository stop until the new hash is reviewed and the
   runner is reinstalled. Commits and pushes run with `core.hooksPath=/dev/null`.
8. After opening a PR, it verifies the PR actor, head and base, the changed
   files, and the commit author and committer. Where the identity sets
   `resolvedLogin` (homecall and sportsapp), it also checks the
   GitHub-resolved login. It waits up to
   `--check-wait-seconds` (default 120) for check runs on the exact head and
   records the count.

Targets fail independently. Every other target still runs, and any failure
makes the exit status 1. The updater does not comment, label, approve, merge,
close issues or deploy.

Git runs with system and global configuration disabled. Pushes use only the
`git-credential-github-app <profile>` helper configured in the temporary clone.
No token is read, printed, passed as an argument or written to disk by this
code.

## Install the daily job

```sh
node scripts/install-runner.mjs \
  --node /absolute/path/to/node \
  --path /absolute/helper/bin:/usr/bin:/bin \
  --hour 9 --minute 17
```

- `--path` becomes the job's entire `PATH`. It must contain `git`,
  `github-app-curl`, `github-app-token`, `git-credential-github-app` and `sh`.
  The installer checks the first four.
- The installer copies the updater files from the clean HEAD to
  `~/Library/Application Support/home-screen-install-updater/runner/<commit>/`,
  read-only. It writes `runner-manifest.json` with their hashes.
- It writes `~/Library/LaunchAgents/com.michaeltorbert.home-screen-install.updater.plist`.
  The plist records the manifest's SHA-256, and every scheduled run verifies
  the installed files against it before doing anything.
- State, logs and the runner live outside `~/Documents`, `~/Desktop` and
  `~/Downloads`, so macOS privacy prompts cannot block the job.
- The job never pulls. Changing the updater takes a reviewed commit and a
  deliberate reinstall with `--replace`.

The installer does not load the job. It prints the commands:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.michaeltorbert.home-screen-install.updater.plist
launchctl print gui/$(id -u)/com.michaeltorbert.home-screen-install.updater
launchctl kickstart gui/$(id -u)/com.michaeltorbert.home-screen-install.updater   # run now
launchctl bootout gui/$(id -u)/com.michaeltorbert.home-screen-install.updater     # disable
```

## Status

| File | Contents |
| --- | --- |
| `~/Library/Application Support/home-screen-install-updater/status.json` | Last run: mode, runner commit, verified releases, per-target state and detail, PR URL, head SHA, check-run count |
| `…/history.jsonl` | One line per run |
| `~/Library/Logs/home-screen-install-updater/updater.{out,err}.log` | launchd output |

Only one run can hold the lock at a time (`run.lock`); an overlapping run exits
with status 2.

## Status vocabulary

Report these separately and never merge them into one "done":

- source published;
- release published;
- setup PR open, then merged (per repository);
- runner installed and loaded;
- runner ran (a no-op was verified);
- update-PR path proven live (needs a real later release; until then it is
  proven only by test fixtures);
- UI adopted (per app issue);
- native verified (per app issue).
