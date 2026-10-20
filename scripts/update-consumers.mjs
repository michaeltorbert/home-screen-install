#!/usr/bin/env node
// Proposes vendored home-screen-install updates to the consumer repositories in
// distribution/consumers.json as ordinary, reviewable pull requests.
//
//   node scripts/update-consumers.mjs --dry-run|--live [--release vX.Y.Z] [--target <name>]...
//                                     [--state-dir <dir>] [--check-wait-seconds <n>] [--scheduled]
//
// For each target it reads the lock on the default branch, picks the newest
// published stable release on the same compatibility line (or the exact
// --release), verifies that release's assets, tag and tagged tree agree, and
// writes only the three vendored files on a version-specific branch. It never
// force-pushes, merges, approves, deploys or comments.
//
// Fetched code is never executed. The vendor check runs in-process from this
// runner's own pinned checker; the consumer's copy is only compared with it.
// The only consumer file ever run is a configured pre-commit script (Math
// Connections' git-safety-check.sh), and only after its bytes match the
// reviewed sha256 in consumers.json, checked before every run.
//
// Exit status: 0 when every target ended in an expected state, 1 otherwise,
// 2 for usage errors or an overlapping run.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CHECKER_TEMPLATE,
  FORMAT_FILES,
  LOCK,
  MANIFEST,
  ROOT,
  RELEASE_ASSETS,
  buildPayload,
  canonicalJson,
  checkPayload,
  compareVersions,
  git,
  loadConsumers,
  parseManifest,
  parseVersion,
  payloadsEqual,
  readVendorDir,
  releaseFromTree,
  sameLine,
  sha256,
  verifyRunner,
} from "./lib/distribution.mjs";
import { appSlug, createAppApi, createPublicSource, findExecutable } from "./lib/github.mjs";

const RUNNER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_STATE_DIR = join(homedir(), "Library", "Application Support", "home-screen-install-updater");
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

// States that are a correct outcome; anything else makes the run fail.
const OK_STATES = new Set(["up-to-date", "pending-bootstrap-merge", "pr-open", "would-open-pr", "pr-opened", "pr-opened-resumed"]);

// ---------------------------------------------------------------------------
// Release selection and verification

/** Published, non-draft, non-prerelease releases with a stable vX.Y.Z tag. */
export function stableReleases(releases) {
  return releases.filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name) && r.tag_name.startsWith("v"));
}

/**
 * Verifies one published release and returns { version, tag, commit, aiAuthor, url, files }.
 * Assets, manifest, peeled tag and tagged-tree bytes must all agree.
 */
export async function verifyRelease(source, release, releaseActors) {
  const tag = release.tag_name;
  if (!releaseActors.includes(release.author?.login)) throw new Error(`${tag} was published by ${release.author?.login}, not an allowed App`);
  const names = release.assets.map((asset) => asset.name).sort();
  if (names.join() !== [...RELEASE_ASSETS].sort().join()) throw new Error(`${tag} assets must be exactly ${RELEASE_ASSETS.join(", ")}`);
  const assets = new Map();
  for (const asset of release.assets) {
    if (asset.size > MAX_ASSET_BYTES) throw new Error(`${tag} asset ${asset.name} is too large`);
    assets.set(asset.name, await source.download(asset.browser_download_url));
  }
  const manifest = parseManifest(assets.get(MANIFEST));
  if (manifest.tag !== tag) throw new Error(`${tag} manifest names ${manifest.tag}`);
  for (const [name, digest] of Object.entries(manifest.assets)) {
    if (sha256(assets.get(name)) !== digest) throw new Error(`${tag} asset ${name} does not match ${MANIFEST}`);
  }
  const peeled = source.resolveTag(tag);
  if (peeled !== manifest.commit) throw new Error(`${tag} tag resolves to ${peeled}, but the release manifest records ${manifest.commit}`);
  const tree = releaseFromTree(source.readTree(tag, manifest.commit), manifest.commit);
  if (tree.version !== manifest.version) throw new Error(`${tag} tagged package.json is ${tree.version}`);
  const pairs = [["classic", FORMAT_FILES.classic], ["esm", FORMAT_FILES.esm], ["sums", "SHA256SUMS"]];
  for (const [key, name] of pairs) {
    if (!tree.files[key].equals(assets.get(name))) throw new Error(`${tag} asset ${name} differs from the tagged tree`);
  }
  return { ...tree, aiAuthor: manifest.aiAuthor, url: release.html_url };
}

// ---------------------------------------------------------------------------
// Pull request text

export function pullRequestBody({ target, current, release, aiAuthor }) {
  const file = FORMAT_FILES[target.format];
  const apps = target.apps.map((app) => `- ${app.name} (\`${app.path}\`): Refs #${app.issue}`).join("\n");
  return [
    `Updates the vendored Home Screen Install component from v${current} to v${release.version}.`,
    "",
    `- Release: ${release.url}`,
    `- Source commit: \`${release.commit}\``,
    `- Format: ${target.format} (\`${target.path}/${file}\`)`,
    `- Changed paths: only \`${target.path}/\` (${file}, SHA256SUMS, ${LOCK})`,
    "",
    "Apps sharing this vendored copy (adoption is tracked in each issue):",
    "",
    apps,
    "",
    "Before an app adopts the component, these vendored copies are inert. After adoption, this PR updates the shared component that app loads, which can change its Add to Home Screen button and guide. Complete that app's normal integration, cache/version and native device checks before merging, and read the release notes.",
    "",
    "This PR adds no new mount and changes no other files. It is never merged or deployed automatically.",
    "",
    "Opened by the home-screen-install local updater, which runs daily only while the configured Mac is on and logged in. It never merges, approves or deploys.",
    "",
    `<!-- ai-author: ${aiAuthor} -->`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// One target

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 300_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${[command, ...args].join(" ")} failed (exit ${result.status ?? result.error?.message}): ${detail}`);
  }
}

/** A per-target refusal with its own status state. */
class Refusal extends Error {
  constructor(state, message) {
    super(message);
    this.state = state;
  }
}

/**
 * Runs the target's reviewed pre-commit scripts with /bin/sh in the temporary
 * checkout. Each script's bytes must match its configured sha256 immediately
 * before it runs; a changed or missing script is refused and never executed.
 */
function runPreCommit(target, cwd) {
  for (const { path, sha256: digest } of target.preCommit) {
    const file = join(cwd, path);
    const bytes = existsSync(file) ? readFileSync(file) : null;
    if (!bytes || sha256(bytes) !== digest) {
      throw new Refusal("pre-commit-mismatch", `${path} is missing or differs from its reviewed sha256; not executed`);
    }
    run("/bin/sh", [file], cwd);
  }
}

/**
 * Verifies the written payload with this runner's own checker (in-process, no
 * consumer code), confirms the consumer's checker is the same reviewed file so
 * its CI agrees, then runs the hash-pinned pre-commit scripts.
 */
function runChecks(ctx, target, cwd) {
  checkPayload(readVendorDir(join(cwd, target.path)), target.format);
  const fetched = join(cwd, ctx.consumers.checker);
  if (!existsSync(fetched) || !readFileSync(fetched).equals(readFileSync(join(ROOT, CHECKER_TEMPLATE)))) {
    throw new Refusal("checker-mismatch", `${ctx.consumers.checker} is missing or differs from the runner's reviewed checker; not executed`);
  }
  runPreCommit(target, cwd);
}

/** True when the branch is exactly one updater commit by `id` that writes `expected`. */
function ownedBranch(cwd, target, id, branchRef, expected) {
  const base = git(["merge-base", "origin/HEAD", branchRef], { cwd }).text;
  const commits = git(["rev-list", `${base}..${branchRef}`], { cwd }).text.split("\n").filter(Boolean);
  if (commits.length !== 1) return `has ${commits.length} commits since ${base.slice(0, 12)}`;
  const who = git(["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce", commits[0]], { cwd }).text.split("\0");
  if (who.join("\0") !== [id.name, id.email, id.name, id.email].join("\0")) return "has a commit by another identity";
  const allowed = new Set([...expected.keys()].map((name) => `${target.path}/${name}`));
  const changed = git(["diff", "--name-only", base, branchRef], { cwd }).text.split("\n").filter(Boolean);
  if (!changed.length || changed.some((path) => !allowed.has(path))) return "changes paths outside the vendor directory";
  for (const [name, bytes] of expected) {
    const got = git(["show", `${branchRef}:${target.path}/${name}`], { cwd, allowFailure: true });
    if (got.status !== 0 || !got.stdout.equals(bytes)) return `has different ${name} content`;
  }
  return null;
}

async function openPull(ctx, target, id, { branch, sha, current, release }) {
  const api = ctx.apiFor(target);
  const pr = await api.createPull(target.repository, {
    title: `Update home-screen-install to v${release.version}`,
    head: branch,
    base: target.defaultBranch,
    body: pullRequestBody({ target, current, release, aiAuthor: release.aiAuthor }),
  });
  const problems = [];
  if (pr.user?.login !== target.actor) problems.push(`opened by ${pr.user?.login}`);
  if (pr.head?.sha !== sha || pr.head?.ref !== branch || pr.base?.ref !== target.defaultBranch) problems.push("head/base mismatch");
  const allowed = new Set([LOCK, "SHA256SUMS", FORMAT_FILES[target.format]].map((name) => `${target.path}/${name}`));
  const files = (await api.listPullFiles(target.repository, pr.number)).map((f) => f.filename);
  if (!files.length || files.some((f) => !allowed.has(f))) problems.push(`unexpected files ${files.join(", ")}`);
  const commit = await api.getCommit(target.repository, sha);
  for (const role of ["author", "committer"]) {
    if (commit.commit?.[role]?.name !== id.name || commit.commit?.[role]?.email !== id.email) problems.push(`${role} identity mismatch`);
    if (id.resolvedLogin && commit[role]?.login !== id.resolvedLogin) problems.push(`${role} resolves to ${commit[role]?.login}`);
  }
  let checkRuns = 0;
  for (let waited = 0; ; waited += 15_000) {
    checkRuns = await api.countCheckRuns(target.repository, sha);
    if (checkRuns > 0 || waited >= ctx.checkWaitMs) break;
    await new Promise((done) => setTimeout(done, 15_000));
  }
  return {
    pr: pr.number,
    url: pr.html_url,
    headSha: sha,
    checkRuns,
    problems,
    resolved: { author: commit.author?.login ?? null, committer: commit.committer?.login ?? null },
  };
}

export async function updateTarget(ctx, target) {
  const cwd = join(ctx.workDir, target.name);
  // No hook template, and hooksPath recorded in the clone's own config, so no
  // repository hook can run for any later git command in this checkout.
  git(["clone", "--quiet", "--template=", "-c", "core.hooksPath=/dev/null", "--no-tags", "--single-branch", "--branch", target.defaultBranch, ctx.remoteUrlFor(target), cwd]);
  git(["remote", "set-head", "origin", target.defaultBranch], { cwd });
  if (ctx.credentialHelper) git(["config", "credential.https://github.com.helper", `${ctx.credentialHelper} ${target.profile}`], { cwd });
  const base = git(["rev-parse", "HEAD"], { cwd }).text;
  const vendorDir = join(cwd, target.path);
  if (!existsSync(join(vendorDir, LOCK))) return { state: "pending-bootstrap-merge", base };

  let lock;
  try {
    lock = checkPayload(readVendorDir(vendorDir), target.format);
  } catch (error) {
    return { state: "vendor-invalid", base, detail: error.message };
  }
  const picked = await ctx.pick(lock.version);
  if (!picked.release) return { state: picked.state, base, current: lock.version, detail: picked.detail };
  const release = picked.release;
  const expected = buildPayload(release, target.format);
  const summary = { base, current: lock.version, proposed: release.version, newerLine: picked.newerLine };

  const order = compareVersions(release.version, lock.version);
  if (order < 0) return { ...summary, state: "downgrade-refused", detail: `newest published release on this line is older than v${lock.version}` };
  if (order === 0) {
    if (release.commit !== lock.commit) return { ...summary, state: "moved-tag", detail: `v${lock.version} now resolves to ${release.commit}, lock has ${lock.commit}` };
    if (!payloadsEqual(readVendorDir(vendorDir), expected)) return { ...summary, state: "vendor-drift", detail: "vendored bytes differ from the release" };
    return { ...summary, state: "up-to-date" };
  }

  // Commits carry the identity this repository prescribes for the release's
  // actual implementer. An author without a reviewed mapping is refused before
  // any write; adding one is a deliberate consumers.json change and reinstall.
  const id = target.commitIdentities[release.aiAuthor];
  if (!id) return { ...summary, state: "unsupported-author", detail: `no reviewed commit identity for ai-author ${release.aiAuthor}` };

  const branch = `${ctx.consumers.branchPrefix}${release.version}`;
  const remote = git(["ls-remote", "origin", `refs/heads/${branch}`], { cwd }).text.split("\n").map((line) => line.split("\t")).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0] || null;
  const pulls = await ctx.apiFor(target).listPulls(target.repository, branch);
  const open = pulls.filter((p) => p.state === "open");
  if (pulls.length && !open.length) return { ...summary, state: "closed-pr-exists", branch, detail: `PR #${pulls[0].number} for ${branch} is closed; not reopening or recreating` };
  if (open.length > 1) return { ...summary, state: "pr-conflict", branch, detail: "more than one open PR for the branch" };

  if (remote) {
    git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd });
    const problem = ownedBranch(cwd, target, id, `refs/remotes/origin/${branch}`, expected);
    if (problem) return { ...summary, state: "branch-conflict", branch, detail: `${branch} ${problem}; left untouched` };
    if (open.length) {
      const pr = open[0];
      if (pr.head?.sha !== remote || pr.base?.ref !== target.defaultBranch) return { ...summary, state: "pr-conflict", branch, detail: `PR #${pr.number} head/base does not match the branch` };
      return { ...summary, state: "pr-open", branch, pr: pr.number, url: pr.html_url, headSha: remote };
    }
    // An owned branch without a PR (an earlier run stopped after pushing): open the missing PR.
    git(["checkout", "--quiet", "-b", branch, `refs/remotes/origin/${branch}`], { cwd });
    runChecks(ctx, target, cwd);
    if (ctx.dryRun) return { ...summary, state: "would-open-pr", branch, detail: "owned branch exists without a PR" };
    const result = await openPull(ctx, target, id, { branch, sha: remote, current: lock.version, release });
    return { ...summary, ...result, branch, state: result.problems.length ? "pr-verification-failed" : "pr-opened-resumed" };
  }
  if (open.length) return { ...summary, state: "pr-conflict", branch, detail: `PR #${open[0].number} is open but its branch is gone` };

  git(["checkout", "--quiet", "-b", branch], { cwd });
  for (const [name, bytes] of expected) writeFileSync(join(vendorDir, name), bytes);
  git(["add", "--", target.path], { cwd });
  const changed = git(["diff", "--cached", "--name-only"], { cwd }).text.split("\n").filter(Boolean);
  const allowed = new Set([...expected.keys()].map((name) => `${target.path}/${name}`));
  if (!changed.length || changed.some((path) => !allowed.has(path))) return { ...summary, state: "unexpected-diff", detail: changed.join(", ") };
  git(["diff", "--cached", "--check"], { cwd });
  runChecks(ctx, target, cwd);
  if (ctx.dryRun) return { ...summary, state: "would-open-pr", branch, changed };

  const env = { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
  git(["-c", "core.hooksPath=/dev/null", "-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "commit", "--quiet", "-m", `Update home-screen-install to v${release.version}`], { cwd, env });
  const sha = git(["rev-parse", "HEAD"], { cwd }).text;
  const recorded = git(["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce"], { cwd }).text;
  if (recorded !== [id.name, id.email, id.name, id.email].join("\0")) return { ...summary, state: "identity-mismatch", branch };
  runPreCommit(target, cwd);
  git(["-c", "core.hooksPath=/dev/null", "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd });
  const result = await openPull(ctx, target, id, { branch, sha, current: lock.version, release });
  return { ...summary, ...result, branch, state: result.problems.length ? "pr-verification-failed" : "pr-opened" };
}

// ---------------------------------------------------------------------------
// Whole run

/**
 * Runs every selected target independently and returns the status report.
 * options: { consumers, source, apiFor(target), remoteUrlFor(target), workDir, dryRun,
 *            exact, only, checkWaitMs, credentialHelper, runner, preflight(profile, appSlug) }
 */
export async function runUpdater(options) {
  const { consumers, source, dryRun, exact, only = [] } = options;
  const report = { schema: 1, startedAt: new Date().toISOString(), mode: dryRun ? "dry-run" : "live", runner: options.runner ?? null, releases: {}, targets: [] };
  const targets = consumers.targets.filter((t) => !only.length || only.includes(t.name));
  const unknown = only.filter((name) => !consumers.targets.some((t) => t.name === name));
  if (unknown.length) throw new Error(`unknown target(s): ${unknown.join(", ")}`);

  let published = null;
  let listError = null;
  try {
    published = stableReleases(await source.listReleases());
  } catch (error) {
    listError = error.message;
  }
  const verified = new Map();
  const verify = async (release) => {
    if (!verified.has(release.tag_name)) {
      verified.set(release.tag_name, verifyRelease(source, release, consumers.source.releaseActors).then(
        (value) => ({ value }),
        (error) => ({ error: error.message })
      ));
    }
    const outcome = await verified.get(release.tag_name);
    report.releases[release.tag_name] = outcome.error ? { error: outcome.error } : { commit: outcome.value.commit, aiAuthor: outcome.value.aiAuthor };
    return outcome;
  };
  const pick = async (currentVersion) => {
    if (listError) return { state: "release-error", detail: listError };
    let candidates = published;
    if (exact) {
      candidates = published.filter((r) => r.tag_name === exact);
      if (!candidates.length) return { state: "release-error", detail: `${exact} is not a published stable release` };
    } else {
      candidates = published.filter((r) => sameLine(r.tag_name, currentVersion));
    }
    const newest = (list) => list.slice().sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    const outside = newest(published.filter((r) => !sameLine(r.tag_name, currentVersion) && compareVersions(r.tag_name, currentVersion) > 0));
    const choice = newest(candidates);
    if (!choice) return { state: "no-release-on-line", detail: outside ? `held: ${outside.tag_name} is on a different line` : "no published release" };
    const outcome = await verify(choice);
    if (outcome.error) return { state: "release-invalid", detail: outcome.error };
    return { release: outcome.value, newerLine: !exact && outside ? outside.tag_name : undefined };
  };

  const preflight = new Map();
  for (const target of targets) {
    const entry = { name: target.name, repository: target.repository };
    try {
      const key = `${target.profile}:${target.appSlug}`;
      if (!preflight.has(key)) {
        preflight.set(key, Promise.resolve().then(() => options.preflight(target.profile, target.appSlug)).then(() => null, (e) => e.message));
      }
      const denied = await preflight.get(key);
      Object.assign(entry, denied ? { state: "app-preflight-failed", detail: denied } : await updateTarget({ ...options, pick }, target));
    } catch (error) {
      entry.state = error instanceof Refusal ? error.state : "error";
      entry.detail = error.message;
    }
    entry.ok = OK_STATES.has(entry.state);
    report.targets.push(entry);
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.targets.length > 0 && report.targets.every((t) => t.ok);
  return report;
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(args) {
  const options = { only: [], checkWaitSeconds: 120 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      return args[++i];
    };
    if (arg === "--dry-run" || arg === "--live") {
      if (options.mode) throw new Error("choose exactly one of --dry-run and --live");
      options.mode = arg.slice(2);
    } else if (arg === "--scheduled") options.scheduled = true;
    else if (arg === "--release") options.exact = value();
    else if (arg === "--target") options.only.push(value());
    else if (arg === "--state-dir") options.stateDir = resolve(value());
    else if (arg === "--check-wait-seconds") options.checkWaitSeconds = Number(value());
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.mode) throw new Error("choose exactly one of --dry-run and --live");
  if (options.exact && !parseVersion(options.exact)) throw new Error("--release must be vX.Y.Z");
  if (options.exact && !options.exact.startsWith("v")) options.exact = `v${options.exact}`;
  if (!Number.isInteger(options.checkWaitSeconds) || options.checkWaitSeconds < 0) throw new Error("--check-wait-seconds must be a whole number");
  return options;
}

function acquireLock(stateDir) {
  const lockDir = join(stateDir, "run.lock");
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let alive = false;
    try {
      const pid = Number(readFileSync(join(lockDir, "pid"), "utf8"));
      process.kill(pid, 0);
      alive = Number.isInteger(pid) && pid > 0;
    } catch {
      // missing pid file or a process that no longer exists: stale lock
    }
    if (alive) return null;
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
  writeFileSync(join(lockDir, "pid"), String(process.pid));
  return () => rmSync(lockDir, { recursive: true, force: true });
}

async function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`update-consumers: ${error.message}`);
    return 2;
  }
  const stateDir = options.stateDir || process.env.HSI_STATE_DIR || DEFAULT_STATE_DIR;
  let runner = null;
  if (options.scheduled) {
    // Scheduled runs execute only the pinned, hash-verified installed copy.
    runner = verifyRunner(RUNNER_ROOT, process.env.HSI_RUNNER_MANIFEST_SHA256);
    const documents = join(homedir(), "Documents");
    if (`${stateDir}/`.startsWith(`${documents}/`) || `${RUNNER_ROOT}/`.startsWith(`${documents}/`)) {
      console.error("update-consumers: scheduled runs must live outside ~/Documents");
      return 2;
    }
  }
  mkdirSync(stateDir, { recursive: true });
  const release = acquireLock(stateDir);
  if (!release) {
    console.error("update-consumers: another run holds the lock; exiting");
    return 2;
  }
  const workRoot = join(stateDir, "work");
  mkdirSync(workRoot, { recursive: true });
  const workDir = mkdtempSync(join(workRoot, "run-"));
  try {
    const consumers = loadConsumers(join(RUNNER_ROOT, "distribution", "consumers.json"));
    const credentialHelper = findExecutable("git-credential-github-app");
    if (/\s/.test(credentialHelper)) throw new Error("credential helper path must not contain whitespace");
    const apis = new Map();
    const report = await runUpdater({
      consumers,
      source: createPublicSource({ repository: consumers.source.repository, scratch: workDir }),
      remoteUrlFor: (target) => `https://github.com/${target.repository}.git`,
      workDir,
      dryRun: options.mode === "dry-run",
      exact: options.exact,
      only: options.only,
      checkWaitMs: options.checkWaitSeconds * 1000,
      credentialHelper,
      runner: runner ? { commit: runner } : null,
      // Each target uses its own mapped App profile, created only after its slug is confirmed.
      preflight: (profile, expectedSlug) => {
        const slug = appSlug(profile);
        if (slug !== expectedSlug) throw new Error(`profile ${profile} resolves to App ${slug}, expected ${expectedSlug}`);
        if (!apis.has(profile)) apis.set(profile, createAppApi(profile));
      },
      apiFor: (target) => apis.get(target.profile),
    });
    const text = canonicalJson(report);
    writeFileSync(join(stateDir, "status.json.tmp"), text);
    renameSync(join(stateDir, "status.json.tmp"), join(stateDir, "status.json"));
    appendFileSync(join(stateDir, "history.jsonl"), JSON.stringify(report) + "\n");
    for (const t of report.targets) console.log(`${t.ok ? "ok  " : "FAIL"} ${t.name}: ${t.state}${t.detail ? ` (${t.detail})` : ""}${t.url ? ` ${t.url}` : ""}`);
    console.log(`status: ${join(stateDir, "status.json")}`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`update-consumers: ${error.message}`);
    return 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
