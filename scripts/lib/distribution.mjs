// Shared helpers for the stage, release, updater and runner-install commands.
// Everything here is local: no network access and no GitHub credentials.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHECKSUMS,
  FORMAT_FILES,
  LOCK,
  PACKAGE,
  SOURCE,
  checkPayload,
  parseChecksums,
  readVendorDir,
  serializeLock,
  sha256,
} from "../../distribution/templates/check-home-screen-install.mjs";

export { CHECKSUMS, FORMAT_FILES, LOCK, PACKAGE, SOURCE, checkPayload, parseChecksums, readVendorDir, serializeLock, sha256 };

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONSUMERS_PATH = "distribution/consumers.json";
export const CHECKER_TEMPLATE = "distribution/templates/check-home-screen-install.mjs";
export const MANIFEST = "release-manifest.json";
export const RELEASE_ASSETS = Object.freeze([FORMAT_FILES.classic, FORMAT_FILES.esm, CHECKSUMS, MANIFEST]);
export const AI_AUTHORS = Object.freeze(["claude", "codex", "human"]);
// Files copied into an installed runner; everything the updater imports.
export const RUNNER_FILES = Object.freeze([
  "scripts/update-consumers.mjs",
  "scripts/lib/distribution.mjs",
  "scripts/lib/github.mjs",
  CONSUMERS_PATH,
  CHECKER_TEMPLATE,
]);
export const RUNNER_MANIFEST = "runner-manifest.json";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** [major, minor, patch] for a stable `x.y.z` or `vx.y.z`, otherwise null. */
export function parseVersion(text) {
  const match = STABLE_TAG.exec(typeof text === "string" && !text.startsWith("v") ? `v${text}` : text);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`cannot compare versions ${a} and ${b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Automatic updates stay on one compatibility line: the same major version,
// and for 0.x also the same minor. Anything else needs an explicit --release.
export function sameLine(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x[0] === y[0] && (x[0] !== 0 || x[1] === y[1]);
}

/** Canonical JSON used for every generated metadata file. */
export function canonicalJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

export function loadConsumers(path = join(ROOT, CONSUMERS_PATH)) {
  const map = JSON.parse(readFileSync(path, "utf8"));
  if (map.schema !== 1 || !Array.isArray(map.targets) || !map.targets.length) throw new Error("consumers: unexpected schema");
  const names = new Set();
  for (const t of map.targets) {
    if (names.has(t.name)) throw new Error(`consumers: duplicate target ${t.name}`);
    names.add(t.name);
    if (!/^michaeltorbert\/[A-Za-z0-9._-]+$/.test(t.repository)) throw new Error(`consumers: ${t.name} repository is not allowed`);
    if (!Object.hasOwn(FORMAT_FILES, t.format)) throw new Error(`consumers: ${t.name} format`);
    if (!/^[a-z0-9][a-z0-9/_-]*[a-z0-9]$/.test(t.path) || t.path.includes("..") || t.path.includes("//")) {
      throw new Error(`consumers: ${t.name} path is not a plain relative path`);
    }
    // Commit identity per release ai-author; an author missing here is refused, never guessed.
    const identities = Object.entries(t.commitIdentities || {});
    if (
      !identities.length ||
      identities.some(([author, id]) =>
        !["claude", "codex"].includes(author) ||
        !id?.name ||
        !/@users\.noreply\.github\.com$/.test(id.email || "") ||
        !(id.resolvedLogin === null || typeof id.resolvedLogin === "string"))
    ) {
      throw new Error(`consumers: ${t.name} needs explicit bot commit identities keyed by ai-author`);
    }
    // Pre-commit scripts are consumer files run with /bin/sh only when their bytes match the reviewed hash.
    if (!Array.isArray(t.preCommit) || t.preCommit.some((p) =>
      Object.keys(p).join() !== "path,sha256" ||
      !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p.path) ||
      p.path.split("/").includes("..") ||
      !/^[0-9a-f]{64}$/.test(p.sha256))) {
      throw new Error(`consumers: ${t.name} pre-commit entries must be { path, sha256 }`);
    }
    if (!t.profile || !t.appSlug || !t.actor || !t.apps?.length) {
      throw new Error(`consumers: ${t.name} is incomplete`);
    }
  }
  return map;
}

/**
 * Reads and validates the distributable files of one source commit.
 * `read(path)` returns the committed bytes of a repository path.
 */
export function releaseFromTree(read, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`release: ${commit} is not a full commit SHA`);
  const pkg = JSON.parse(read("package.json").toString("utf8"));
  if (pkg.name !== PACKAGE || !parseVersion(pkg.version) || pkg.version.startsWith("v")) {
    throw new Error("release: package.json must name home-screen-install with a stable x.y.z version");
  }
  const files = {
    classic: read(`dist/${FORMAT_FILES.classic}`),
    esm: read(`dist/${FORMAT_FILES.esm}`),
    sums: read(`dist/${CHECKSUMS}`),
  };
  const sums = parseChecksums(files.sums.toString("utf8"));
  if ([...sums.keys()].sort().join() !== [FORMAT_FILES.classic, FORMAT_FILES.esm].sort().join()) {
    throw new Error(`release: dist/${CHECKSUMS} must list exactly the two scripts`);
  }
  for (const format of ["classic", "esm"]) {
    if (sums.get(FORMAT_FILES[format]) !== sha256(files[format])) throw new Error(`release: dist/${FORMAT_FILES[format]} does not match ${CHECKSUMS}`);
    if (!files[format].toString("utf8").startsWith(`/*! ${PACKAGE} v${pkg.version} |`)) {
      throw new Error(`release: dist/${FORMAT_FILES[format]} banner does not name v${pkg.version}`);
    }
  }
  return { version: pkg.version, tag: `v${pkg.version}`, commit, files };
}

/** The exact vendored payload for one format: Map<file name, Buffer>. */
export function buildPayload(release, format) {
  const file = FORMAT_FILES[format];
  const script = release.files[format];
  const lock = {
    schema: 1,
    package: PACKAGE,
    source: SOURCE,
    version: release.version,
    tag: release.tag,
    commit: release.commit,
    format,
    file,
    sha256: sha256(script),
  };
  const files = new Map([
    [CHECKSUMS, Buffer.from(release.files.sums)],
    [file, Buffer.from(script)],
    [LOCK, Buffer.from(serializeLock(lock), "utf8")],
  ]);
  checkPayload(files, format);
  return files;
}

export function payloadsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [name, bytes] of a) if (!b.has(name) || !b.get(name).equals(bytes)) return false;
  return true;
}

/** Release manifest asset; aiAuthor records who actually implemented the release. */
export function buildManifest(release, aiAuthor) {
  if (!AI_AUTHORS.includes(aiAuthor)) throw new Error(`release: ai author must be one of ${AI_AUTHORS.join(", ")}`);
  const assets = {
    [FORMAT_FILES.classic]: sha256(release.files.classic),
    [FORMAT_FILES.esm]: sha256(release.files.esm),
    [CHECKSUMS]: sha256(release.files.sums),
  };
  return Buffer.from(
    canonicalJson({ schema: 1, package: PACKAGE, version: release.version, tag: release.tag, commit: release.commit, aiAuthor, assets }),
    "utf8"
  );
}

export function parseManifest(bytes) {
  const text = bytes.toString("utf8");
  const manifest = JSON.parse(text);
  const keys = ["schema", "package", "version", "tag", "commit", "aiAuthor", "assets"];
  if (Object.keys(manifest).join() !== keys.join() || canonicalJson(manifest) !== text) throw new Error(`${MANIFEST} is not in canonical form`);
  if (manifest.schema !== 1 || manifest.package !== PACKAGE) throw new Error(`${MANIFEST} names an unexpected package`);
  if (!parseVersion(manifest.version) || manifest.tag !== `v${manifest.version}`) throw new Error(`${MANIFEST} version/tag mismatch`);
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error(`${MANIFEST} commit is not a full SHA`);
  if (!AI_AUTHORS.includes(manifest.aiAuthor)) throw new Error(`${MANIFEST} has an ambiguous ai author`);
  const names = [FORMAT_FILES.classic, FORMAT_FILES.esm, CHECKSUMS];
  if (Object.keys(manifest.assets).sort().join() !== names.sort().join()) throw new Error(`${MANIFEST} lists unexpected assets`);
  return manifest;
}

/** Copy of `object` with keys in code-unit order. */
export function sortedObject(object) {
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

/** Hash of every file under `root` (relative POSIX paths, sorted), excluding `except`. */
export function hashTree(root, except = []) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      if (except.includes(rel)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else out[rel] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return sortedObject(out);
}

/** Verifies an installed runner against the manifest hash recorded in its launchd job. */
export function verifyRunner(runnerRoot, expectedManifestSha256) {
  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256 || "")) throw new Error("runner: HSI_RUNNER_MANIFEST_SHA256 is not set");
  const bytes = readFileSync(join(runnerRoot, RUNNER_MANIFEST));
  if (sha256(bytes) !== expectedManifestSha256) throw new Error("runner: manifest hash does not match the launchd job");
  const manifest = JSON.parse(bytes.toString("utf8"));
  const actual = hashTree(runnerRoot, [RUNNER_MANIFEST]);
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) throw new Error("runner: installed files differ from the manifest");
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error("runner: manifest commit is not a full SHA");
  return manifest.commit;
}

/**
 * Runs git isolated from system/global configuration (so no personal
 * credential helper or hook can be picked up) and without prompts.
 */
export function git(args, { cwd, input, env, allowFailure = false } = {}) {
  // Inherited config injection and askpass programs are dropped as well.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_ASKPASS|SSH_ASKPASS)$/.test(key))
  );
  const result = spawnSync(process.env.HSI_GIT || "git", args, {
    cwd,
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  if (result.error) throw result.error;
  const stdout = result.stdout || Buffer.alloc(0);
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || "").toString("utf8").trim().split("\n").slice(-3).join(" | ");
    const command = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c") || args[0];
    throw new Error(`git ${command} failed (exit ${result.status}): ${detail}`);
  }
  return { status: result.status, stdout, text: stdout.toString("utf8").trim() };
}

/** Reads committed bytes at `commit` from the repository at `cwd`. */
export function treeReader(cwd, commit) {
  return (path) => git(["show", `${commit}:${path}`], { cwd }).stdout;
}

/** Fails unless the checkout has no staged, unstaged or untracked changes. */
export function requireClean(cwd, what) {
  const status = git(["status", "--porcelain", "--untracked-files=all"], { cwd }).text;
  if (status) throw new Error(`${what}: checkout is not clean:\n${status}`);
  return git(["rev-parse", "--verify", "HEAD^{commit}"], { cwd }).text;
}

/** Parses `git ls-remote` output for one tag; prefers the peeled commit. */
export function peeledTag(lsRemoteText, tag) {
  let direct = null;
  let peeled = null;
  for (const line of lsRemoteText.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t");
    if (ref === `refs/tags/${tag}^{}`) peeled = sha;
    else if (ref === `refs/tags/${tag}`) direct = sha;
  }
  return peeled || direct;
}
