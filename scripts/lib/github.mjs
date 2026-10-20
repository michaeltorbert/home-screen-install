// GitHub access for the release and updater commands.
//
// Authenticated JSON calls go only through the installed GitHub App helper
// (`github-app-curl --profile <profile>`); this module never reads, prints,
// passes or stores a token. Public reads of the source repository, including
// every binary asset download, use plain unauthenticated HTTPS and git.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { git, peeledTag } from "./distribution.mjs";

export const API = "https://api.github.com";
const MAX_BYTES = 4 * 1024 * 1024;
const PER_PAGE = 100;

export function findExecutable(name, pathValue = process.env.PATH || "") {
  for (const dir of pathValue.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(`${name} was not found on PATH`);
}

/**
 * Refuses repository git configuration that could route traffic for `url`
 * around the App helper: any credential setting other than a plain or
 * host-level helper (both reset by appPushArgs), any http.* setting (extra
 * headers, cookies, proxies, client certificates) and any url.* rewrite.
 * Includes are followed; system and global configuration are already disabled.
 */
export function assertIsolatedRemoteConfig(cwd, url) {
  const { origin } = new URL(url);
  const allowed = new Set(["credential.helper", `credential.${origin}.helper`]);
  const keys = git(["config", "--includes", "--get-regexp", "^(credential|http|url)\\."], { cwd, allowFailure: true })
    .text.split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[0]);
  const unexpected = [...new Set(keys.filter((key) => !allowed.has(key)))];
  if (unexpected.length) {
    throw new Error(`refusing repository git config that could change credentials or URLs for ${url}: ${unexpected.join(", ")}`);
  }
}

/**
 * Git `-c` arguments for a push to `url` that only `<helper> <profile>` can
 * authenticate. Command-line values are read after repository config, so the
 * empty values clear every inherited credential helper (plain and host-scoped)
 * and every extra HTTP header for the URL before the mapped helper is added.
 * Askpass and hooks are disabled.
 */
export function appPushArgs(url, helper, profile) {
  if (!helper || /\s/.test(helper) || !/^[a-z0-9-]+$/.test(profile || "")) throw new Error("push: credential helper path and profile are required");
  const { origin } = new URL(url);
  return [
    "-c", "credential.helper=",
    "-c", `credential.${origin}.helper=`,
    "-c", `credential.${origin}.helper=${helper} ${profile}`,
    "-c", "credential.useHttpPath=false",
    "-c", `http.${url}.extraHeader=`,
    "-c", "core.askPass=",
    "-c", "core.hooksPath=/dev/null",
  ];
}

/** Pushes one new tag (never forced) to the explicit `url` through the mapped App helper only. */
export function pushTag({ cwd, url, commit, tag, helper, profile }) {
  git([...appPushArgs(url, helper, profile), "push", "--quiet", url, `${commit}:refs/tags/${tag}`], { cwd });
}

/** Reads the App slug for a helper profile. Only the slug is kept. */
export function appSlug(profile, tool = findExecutable("github-app-token")) {
  const result = spawnSync(tool, [profile, "--app"], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`github-app-token ${profile} --app failed (exit ${result.status})`);
  try {
    return JSON.parse(result.stdout).slug;
  } catch {
    throw new Error("github-app-token --app did not return JSON");
  }
}

async function allPages(fetchPage) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const items = await fetchPage(page);
    if (!Array.isArray(items)) throw new Error("expected a JSON array page");
    all.push(...items);
    if (items.length < PER_PAGE) return all;
  }
  throw new Error("more than 50 pages; refusing to continue");
}

/**
 * One JSON API request through github-app-curl. Returns { status, body: Buffer }.
 *
 * The wrapper already sends `Accept: application/vnd.github+json`, the
 * Authorization header and `X-GitHub-Api-Version`. Repeating any of them sends
 * a duplicate header (curl does not merge custom headers), which GitHub can
 * reject with HTTP 400, and a second Accept cannot replace the wrapper's. So
 * this adds no Accept or version header, and authenticated requests are JSON
 * only. Binary assets are read anonymously from their public download URLs.
 */
export function appRequest(profile, method, url, { json, file, curl } = {}) {
  const args = ["--profile", profile, "-sS", "--max-time", "120", "-X", method];
  if (method === "GET") args.push("-L");
  args.push("-w", "\n%{http_code}");
  let input;
  if (json !== undefined) {
    args.push("-H", "Content-Type: application/json", "--data-binary", "@-");
    input = JSON.stringify(json);
  } else if (file) {
    args.push("-H", "Content-Type: application/octet-stream", "--data-binary", `@${file}`);
  }
  args.push(url);
  const result = spawnSync(curl || findExecutable("github-app-curl"), args, { input: input ?? "", maxBuffer: MAX_BYTES * 4, timeout: 180_000 });
  const where = url.replace(/\?.*$/, "");
  if (result.error) throw new Error(`github-app-curl ${method} ${where}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`github-app-curl ${method} ${where} failed (exit ${result.status})`);
  const out = result.stdout;
  const cut = out.lastIndexOf(0x0a);
  return { status: Number(out.subarray(cut + 1).toString("utf8")), body: out.subarray(0, cut) };
}

function expect(res, statuses, what) {
  if (!statuses.includes(res.status)) {
    let message = "";
    try {
      message = `: ${JSON.parse(res.body.toString("utf8")).message}`;
    } catch {
      // body withheld
    }
    throw new Error(`${what}: HTTP ${res.status}${message}`);
  }
  return res.body.length ? JSON.parse(res.body.toString("utf8")) : null;
}

/** App-authenticated API used for consumer pull requests and source releases. */
export function createAppApi(profile, { curl } = {}) {
  const call = (method, path, options = {}) => appRequest(profile, method, path.startsWith("https://") ? path : `${API}${path}`, { curl, ...options });
  const list = (path, what) => allPages((page) => expect(call("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`), [200], what));
  return {
    listPulls(repo, branch) {
      const head = encodeURIComponent(`${repo.split("/")[0]}:${branch}`);
      return list(`/repos/${repo}/pulls?state=all&head=${head}`, "list pull requests");
    },
    async createPull(repo, body) {
      return expect(call("POST", `/repos/${repo}/pulls`, { json: body }), [201], "create pull request");
    },
    listPullFiles(repo, number) {
      return list(`/repos/${repo}/pulls/${number}/files`, "list pull request files");
    },
    async getCommit(repo, sha) {
      return expect(call("GET", `/repos/${repo}/commits/${sha}`), [200], "read commit");
    },
    async countCheckRuns(repo, sha) {
      return expect(call("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=1`), [200], "read check runs").total_count;
    },
    async getReleaseByTag(repo, tag) {
      const res = call("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
      return res.status === 404 ? null : expect(res, [200], "read release");
    },
    listReleases(repo) {
      return list(`/repos/${repo}/releases`, "list releases");
    },
    async createRelease(repo, body) {
      return expect(call("POST", `/repos/${repo}/releases`, { json: body }), [201], "create draft release");
    },
    async uploadAsset(uploadUrl, name, file) {
      const url = `${uploadUrl.replace(/\{[^}]*\}$/, "")}?name=${encodeURIComponent(name)}`;
      return expect(call("POST", url, { file }), [201], `upload ${name}`);
    },
    /** Asset metadata, including GitHub's `size`, `state` and `digest` ("sha256:<hex>"). */
    listAssets(repo, id) {
      return list(`/repos/${repo}/releases/${id}/assets`, "list release assets");
    },
    async updateRelease(repo, id, body) {
      return expect(call("PATCH", `/repos/${repo}/releases/${id}`, { json: body }), [200], "update release");
    },
  };
}

/**
 * Unauthenticated view of the public source repository: published releases,
 * their downloadable assets, tag resolution and tagged-tree contents.
 */
export function createPublicSource({ repository, scratch, apiBase = API, gitUrl = `https://github.com/${repository}.git` }) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "home-screen-install-updater" };
  async function get(url) {
    const res = await fetch(url, { headers, redirect: "follow" });
    if (!res.ok) throw new Error(`GET ${url.replace(/\?.*$/, "")}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error(`GET ${url}: response larger than ${MAX_BYTES} bytes`);
    return bytes;
  }
  return {
    repository,
    listReleases() {
      return allPages(async (page) => JSON.parse((await get(`${apiBase}/repos/${repository}/releases?per_page=${PER_PAGE}&page=${page}`)).toString("utf8")));
    },
    download: get,
    resolveTag(tag) {
      return peeledTag(git(["ls-remote", gitUrl, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).stdout.toString("utf8"), tag);
    },
    /** Fetches only the tag into a scratch bare repository and returns a path reader. */
    readTree(tag, commit) {
      const dir = mkdtempSync(join(scratch, "source-"));
      git(["init", "--bare", "--quiet", dir]);
      git(["fetch", "--quiet", "--no-tags", "--depth", "1", gitUrl, `+refs/tags/${tag}:refs/tags/${tag}`], { cwd: dir });
      const fetched = git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], { cwd: dir }).text;
      if (fetched !== commit) throw new Error(`tag ${tag} now points at ${fetched}, not ${commit}`);
      return (path) => git(["show", `${commit}:${path}`], { cwd: dir }).stdout;
    },
  };
}
