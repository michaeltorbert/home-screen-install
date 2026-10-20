// Distribution tooling tests: the offline vendor checker, bootstrap staging,
// the consumer updater against local git repositories and a loopback release
// server, the release publisher against an in-memory API, and runner pinning.
// GitHub is simulated throughout; nothing here uses the network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { ROOT, readPackage } from "../scripts/build.mjs";
import { TEMPLATE, renderPlist } from "../scripts/install-runner.mjs";
import {
  CHECKER_TEMPLATE,
  CHECKSUMS,
  FORMAT_FILES,
  LOCK,
  RUNNER_FILES,
  RUNNER_MANIFEST,
  buildManifest,
  buildPayload,
  canonicalJson,
  git,
  hashTree,
  loadConsumers,
  readVendorDir,
  releaseFromTree,
  sha256,
  treeReader,
  verifyRunner,
} from "../scripts/lib/distribution.mjs";
import { createAppApi, createPublicSource } from "../scripts/lib/github.mjs";
import { changelogSection, publishRelease } from "../scripts/release.mjs";
import { stageConsumer } from "../scripts/stage-consumer.mjs";
import { runUpdater } from "../scripts/update-consumers.mjs";

const SOURCE_REPO = "michaeltorbert/home-screen-install";
const BOT = { name: "claude-bot-mt[bot]", email: "275554496+claude-bot-mt[bot]@users.noreply.github.com" };
const HUMAN = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const consumers = loadConsumers();
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "hsi-distribution-test-")));
const servers = [];
after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  rmSync(scratch, { recursive: true, force: true });
});

const g = (cwd, ...args) => git(args, { cwd, env: HUMAN }).text;
let counter = 0;
const fresh = (name) => {
  const dir = join(scratch, `${name}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const writeTree = (dir, files) => {
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
};

// Fixture dist files for any version, derived from the real 0.1.0 build.
const realDist = Object.fromEntries(Object.entries(FORMAT_FILES).map(([format, file]) => [format, readFileSync(join(ROOT, "dist", file))]));
function distFor(version) {
  const files = {};
  for (const [format, file] of Object.entries(FORMAT_FILES)) {
    files[`dist/${file}`] = Buffer.from(realDist[format].toString("utf8").replace(/^\/\*! home-screen-install v[0-9.]+ \|/, `/*! home-screen-install v${version} |`));
  }
  files[`dist/${CHECKSUMS}`] = `${sha256(files["dist/home-screen-install.js"])}  home-screen-install.js\n${sha256(files["dist/home-screen-install.mjs"])}  home-screen-install.mjs\n`;
  return files;
}

/** A source repository (work tree + bare origin) with one commit per version. */
function sourceFixture() {
  const bare = fresh("source.git");
  g(bare, "init", "--quiet", "--bare", "-b", "main");
  const work = fresh("source");
  g(work, "init", "--quiet", "-b", "main");
  // origin names the real repository (the publisher checks it); fixture traffic goes to the bare copy.
  g(work, "remote", "add", "origin", `https://github.com/${SOURCE_REPO}.git`);
  const commits = {};
  return {
    bare,
    work,
    url: `file://${bare}`,
    commits,
    commit(version, note = "") {
      writeTree(work, {
        "package.json": JSON.stringify({ name: "home-screen-install", version }, null, 2) + "\n",
        "CHANGELOG.md": `# Changelog\n\n## ${version}\n\nFixture ${version}.${note}\n`,
        // Stage compares consumers' checkers with the committed template.
        [CHECKER_TEMPLATE]: readFileSync(join(ROOT, CHECKER_TEMPLATE)),
        ...distFor(version),
      });
      g(work, "add", "-A");
      g(work, "commit", "--quiet", "-m", `v${version}${note}`);
      g(work, "push", "--quiet", bare, "HEAD:refs/heads/main");
      return (commits[version] = g(work, "rev-parse", "HEAD"));
    },
    tag(version, commit = commits[version], force = false) {
      g(work, "tag", ...(force ? ["-f"] : []), `v${version}`, commit);
      g(work, "push", "--quiet", ...(force ? ["--force"] : []), bare, `refs/tags/v${version}`);
    },
    release(version, commit = commits[version]) {
      return releaseFromTree(treeReader(work, commit), commit);
    },
  };
}

/** Loopback server standing in for the public releases API and asset downloads. */
async function releaseServer() {
  const state = { releases: [], assets: new Map() };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === `/repos/${SOURCE_REPO}/releases`) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(url.searchParams.get("page") === "1" ? state.releases : []));
    } else if (state.assets.has(url.pathname)) {
      res.end(state.assets.get(url.pathname));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.publish = (release, { draft = false, prerelease = false } = {}) => {
    const assets = [
      [FORMAT_FILES.classic, release.files.classic],
      [FORMAT_FILES.esm, release.files.esm],
      [CHECKSUMS, release.files.sums],
      ["release-manifest.json", buildManifest(release, "claude")],
    ];
    for (const [name, bytes] of assets) state.assets.set(`/download/${release.tag}/${name}`, bytes);
    state.releases.push({
      tag_name: release.tag,
      draft,
      prerelease,
      html_url: `https://example.invalid/releases/${release.tag}`,
      author: { login: "claude-bot-mt[bot]" },
      assets: assets.map(([name, bytes]) => ({ name, size: bytes.length, browser_download_url: `${state.url}/download/${release.tag}/${name}` })),
    });
  };
  return state;
}

function target(name, path, format, extra = {}) {
  return {
    name,
    repository: `michaeltorbert/${name}`,
    defaultBranch: "main",
    path,
    format,
    profile: "claude",
    appSlug: "claude-bot-mt",
    actor: "claude-bot-mt[bot]",
    commitIdentities: { claude: { ...BOT, resolvedLogin: null } },
    preCommit: [],
    apps: [{ name: `${name} app`, path: "/", issue: 7 }],
    ...extra,
  };
}

/** A consumer bare repository whose main has the checker and, optionally, a vendored release. */
function consumerFixture(t, release, mutate) {
  const bare = fresh(`${t.name}.git`);
  g(bare, "init", "--quiet", "--bare", "-b", "main");
  const seed = fresh(`${t.name}-seed`);
  g(seed, "init", "--quiet", "-b", "main");
  const files = { "README.md": "fixture\n", [consumers.checker]: readFileSync(join(ROOT, CHECKER_TEMPLATE)) };
  if (release) for (const [name, bytes] of buildPayload(release, t.format)) files[`${t.path}/${name}`] = bytes;
  mutate?.(files);
  writeTree(seed, files);
  g(seed, "add", "-A");
  g(seed, "commit", "--quiet", "-m", "seed");
  g(seed, "remote", "add", "origin", bare);
  g(seed, "push", "--quiet", "origin", "main");
  return { bare, seed };
}

/** In-memory pull request API backed by the bare repositories. */
function fakePulls(bares) {
  const pulls = [];
  const copy = (value) => structuredClone(value);
  return {
    pulls,
    async listPulls(repo, branch) {
      return pulls.filter((p) => p.repo === repo && p.head.ref === branch).map(copy);
    },
    async createPull(repo, body) {
      const sha = git(["rev-parse", `refs/heads/${body.head}`], { cwd: bares[repo] }).text;
      const number = pulls.length + 1;
      const pr = { repo, number, state: "open", user: { login: "claude-bot-mt[bot]" }, head: { ref: body.head, sha }, base: { ref: body.base }, title: body.title, body: body.body, html_url: `https://example.invalid/${repo}/pull/${number}` };
      pulls.push(pr);
      return copy(pr);
    },
    async listPullFiles(repo, number) {
      const pr = pulls.find((p) => p.repo === repo && p.number === number);
      return git(["diff", "--name-only", `${pr.base.ref}...${pr.head.sha}`], { cwd: bares[repo] }).text.split("\n").filter(Boolean).map((filename) => ({ filename }));
    },
    async getCommit(repo, sha) {
      const [an, ae, cn, ce] = git(["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce", sha], { cwd: bares[repo] }).text.split("\0");
      return { commit: { author: { name: an, email: ae }, committer: { name: cn, email: ce } }, author: null, committer: null };
    },
    async countCheckRuns() {
      return 0;
    },
  };
}

function updater({ source, server, targets, bares, api, ...rest }) {
  const workDir = fresh("run");
  return runUpdater({
    consumers: { ...consumers, targets },
    source: createPublicSource({ repository: SOURCE_REPO, scratch: workDir, apiBase: server.url, gitUrl: `file://${source.bare}` }),
    apiFor: () => api,
    remoteUrlFor: (t) => `file://${bares[t.repository]}`,
    workDir,
    dryRun: false,
    checkWaitMs: 0,
    credentialHelper: null,
    preflight: () => {},
    ...rest,
  });
}

const heads = (bare) => g(bare, "for-each-ref", "--format=%(refname) %(objectname)");
const byName = (report) => Object.fromEntries(report.targets.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------

test("consumer map covers the six apps in four repositories with the agreed paths and identities", () => {
  const shared = { name: "codex-michaeltorbert[bot]", email: "3357630+codex-michaeltorbert[bot]@users.noreply.github.com", resolvedLogin: null };
  const claude = { ...BOT, resolvedLogin: "claude-bot-mt[bot]" };
  const summary = consumers.targets.map((t) => [t.repository, t.path, t.format, t.commitIdentities, t.apps.map((a) => a.issue)]);
  assert.deepEqual(summary, [
    // games and math prescribe one shared local identity for every agent.
    ["michaeltorbert/games", "shared/home-screen-install", "classic", { claude: shared, codex: shared }, [193, 194, 195]],
    ["michaeltorbert/math-connections", "src/vendor/home-screen-install", "esm", { claude: shared, codex: shared }, [4]],
    // homecall and sportsapp require the implementing AI's own bot; only Claude is configured.
    ["michaeltorbert/homecall", "src/vendor/home-screen-install", "esm", { claude }, [52]],
    ["michaeltorbert/sportsapp", "src/vendor/home-screen-install", "esm", { claude }, [169]],
  ]);
  assert.deepEqual(consumers.targets.find((t) => t.name === "math-connections").preCommit, [
    { path: "scripts/git-safety-check.sh", sha256: "43d49086685598d18ae747e26af1ede46cf5cac142bfcb71d6ef9df04aa41bfd" },
  ]);
  for (const t of consumers.targets.filter((t) => t.name !== "math-connections")) assert.deepEqual(t.preCommit, []);
  for (const t of consumers.targets) assert.equal(t.actor, "claude-bot-mt[bot]");
});

test("the 0.1.0 dist files are the frozen approved bytes", { skip: readPackage().version !== "0.1.0" }, () => {
  assert.equal(sha256(realDist.classic), "e9e5bf6a928cdc5175bd7ad7aa86ee8298714d67eefa832a43a8484a24c13822");
  assert.equal(sha256(realDist.esm), "232db01164ca5ac569d6d1e40a6bf6ad21ce4d5342f04c516194d2d2b8754634");
});

test("the package version has release notes and a valid release payload", () => {
  const version = readPackage().version;
  assert.notEqual(changelogSection(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version), "");
  const release = releaseFromTree((path) => readFileSync(join(ROOT, path)), "0".repeat(40));
  assert.equal(release.version, version);
  for (const format of ["classic", "esm"]) assert.equal(buildPayload(release, format).size, 3);
});

test("vendored payload passes the offline checker and any tampering fails it", () => {
  const source = sourceFixture();
  const release = source.release("0.1.0", source.commit("0.1.0"));
  const dir = fresh("vendor");
  const check = (format) => spawnSync(process.execPath, [join(ROOT, CHECKER_TEMPLATE), dir, format], { encoding: "utf8" });
  const place = (files) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
  };

  for (const format of ["classic", "esm"]) {
    place(buildPayload(release, format));
    const ok = check(format);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(check(format === "esm" ? "classic" : "esm").status, 1, "wrong format is rejected");
  }

  const esm = FORMAT_FILES.esm;
  const tamper = {
    "flipped script byte": (f) => {
      const bytes = Buffer.from(f.get(esm));
      bytes[bytes.length - 2] ^= 1;
      f.set(esm, bytes);
    },
    "edited lock version": (f) => f.set(LOCK, Buffer.from(f.get(LOCK).toString().replace('"version": "0.1.0"', '"version": "0.1.1"'))),
    "edited lock commit": (f) => f.set(LOCK, Buffer.from(f.get(LOCK).toString().replace(/"commit": "[0-9a-f]/, '"commit": "g'))),
    "non-canonical lock": (f) => f.set(LOCK, Buffer.from(JSON.stringify(JSON.parse(f.get(LOCK))) + "\n")),
    "wrong checksum entry": (f) => f.set(CHECKSUMS, Buffer.from(f.get(CHECKSUMS).toString().replace(/^[0-9a-f]{64}(?= {2}home-screen-install\.mjs$)/m, "0".repeat(64)))),
    "missing checksums": (f) => f.delete(CHECKSUMS),
    "extra file": (f) => f.set("notes.txt", Buffer.from("x")),
  };
  for (const [name, change] of Object.entries(tamper)) {
    const files = buildPayload(release, "esm");
    change(files);
    place(files);
    const result = check("esm");
    assert.equal(result.status, 1, `${name} must fail`);
    assert.match(result.stderr, /check-home-screen-install:/, name);
  }
});

test("updater opens one bounded PR per target, matching staged bytes, and a rerun writes nothing", async () => {
  const source = sourceFixture();
  const server = await releaseServer();
  for (const version of ["0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.2.0"]) {
    source.commit(version);
    source.tag(version);
  }
  server.publish(source.release("0.1.0"));
  server.publish(source.release("0.1.1"));
  server.publish(source.release("0.1.2"), { prerelease: true });
  server.publish(source.release("0.1.3"), { draft: true });
  server.publish(source.release("0.2.0"));

  const targets = [target("games", "shared/home-screen-install", "classic"), target("sportsapp", "src/vendor/home-screen-install", "esm")];
  const bares = {};
  for (const t of targets) bares[t.repository] = consumerFixture(t, source.release("0.1.0")).bare;
  const api = fakePulls(bares);
  const branch = "home-screen-install/v0.1.1";

  const dry = await updater({ source, server, targets, bares, api, dryRun: true });
  assert.equal(dry.ok, true, canonicalJson(dry));
  assert.deepEqual(dry.targets.map((t) => t.state), ["would-open-pr", "would-open-pr"]);
  assert.equal(api.pulls.length, 0);
  for (const t of targets) assert.doesNotMatch(heads(bares[t.repository]), /home-screen-install\/v/);

  const report = await updater({ source, server, targets, bares, api });
  assert.equal(report.ok, true, canonicalJson(report));
  for (const t of targets) {
    const entry = byName(report)[t.name];
    assert.equal(entry.state, "pr-opened");
    assert.equal(entry.current, "0.1.0");
    assert.equal(entry.proposed, "0.1.1", "prerelease, draft and other-line releases are not proposed");
    assert.equal(entry.newerLine, "v0.2.0");
    const bare = bares[t.repository];
    const changed = g(bare, "diff", "--name-only", `main...${branch}`).split("\n").sort();
    assert.deepEqual(changed, [CHECKSUMS, FORMAT_FILES[t.format], LOCK].map((n) => `${t.path}/${n}`).sort());
    assert.equal(g(bare, "rev-list", "--count", `main..${branch}`), "1");
    assert.equal(g(bare, "log", "-1", "--format=%an|%ae|%cn|%ce", branch), `${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`);

    // The bootstrap stage command must produce exactly the bytes the updater wrote.
    const into = fresh(`${t.name}-stage`);
    g(scratch, "clone", "--quiet", bare, into);
    g(into, "remote", "set-url", "origin", `https://github.com/${t.repository}.git`);
    g(source.work, "checkout", "--quiet", source.commits["0.1.1"]);
    try {
      const staged = stageConsumer({ root: source.work, consumers: { ...consumers, targets }, target: t.name, into, checkDist: () => [] });
      assert.equal(staged.commit, source.commits["0.1.1"]);
    } finally {
      g(source.work, "checkout", "--quiet", "main");
    }
    for (const [name, bytes] of readVendorDir(join(into, t.path))) {
      assert.ok(git(["show", `${branch}:${t.path}/${name}`], { cwd: bare }).stdout.equals(bytes), `${t.name} ${name}`);
    }
  }
  assert.equal(api.pulls.length, 2);
  for (const pr of api.pulls) {
    assert.equal(pr.head.ref, branch);
    assert.equal(pr.body.match(/ai-author/g).length, 1);
    assert.match(pr.body, /<!-- ai-author: claude -->/);
    assert.match(pr.body, /Refs #7/);
    assert.doesNotMatch(pr.body, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #/i);
  }

  const before = targets.map((t) => heads(bares[t.repository]));
  const again = await updater({ source, server, targets, bares, api });
  assert.equal(again.ok, true, canonicalJson(again));
  assert.deepEqual(again.targets.map((t) => t.state), ["pr-open", "pr-open"]);
  assert.equal(api.pulls.length, 2, "no duplicate PR");
  assert.deepEqual(targets.map((t) => heads(bares[t.repository])), before, "no new commit or branch");
});

test("updater refuses unsafe states per target, continues with the rest and fails the run", async () => {
  const source = sourceFixture();
  const server = await releaseServer();
  for (const version of ["0.1.0", "0.1.1", "0.1.5"]) source.commit(version);
  source.tag("0.1.0");
  source.tag("0.1.1");
  server.publish(source.release("0.1.0"));
  server.publish(source.release("0.1.1"));
  const v010 = source.release("0.1.0");
  const branch = "home-screen-install/v0.1.1";

  const esm = (name, extra) => target(name, "src/vendor/home-screen-install", "esm", extra);
  // Consumer files that record when they are executed.
  const marker = (name) => join(scratch, `marker-${name}`);
  const records = (name) => `echo ran >> "${marker(name)}"\n`;
  const pinned = (body) => ({ preCommit: [{ path: "scripts/safety.sh", sha256: sha256(Buffer.from(body)) }] });
  const withFile = (path, body) => (files) => { files[path] = body; };
  const tamperedChecker = `${readFileSync(join(ROOT, CHECKER_TEMPLATE), "utf8")}\nimport("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(marker("checker"))}, "ran"));\n`;
  const cases = {
    pending: [esm("pending"), null],
    ahead: [esm("ahead"), source.release("0.1.5")],
    edited: [esm("edited"), v010, (files) => { files["src/vendor/home-screen-install/home-screen-install.mjs"] += "// hand edit\n"; }],
    foreign: [esm("foreign"), v010],
    closed: [esm("closed"), v010],
    failing: [esm("failing", pinned("exit 3\n")), v010, withFile("scripts/safety.sh", "exit 3\n")],
    "tampered-checker": [esm("tampered-checker"), v010, withFile(consumers.checker, tamperedChecker)],
    "tampered-safety": [esm("tampered-safety", pinned(records("reviewed"))), v010, withFile("scripts/safety.sh", records("tampered"))],
    "exact-safety": [esm("exact-safety", pinned(records("exact"))), v010, withFile("scripts/safety.sh", records("exact"))],
    "codex-only": [esm("codex-only", { commitIdentities: { codex: { name: "codex-bot-mt[bot]", email: "275535971+codex-bot-mt[bot]@users.noreply.github.com", resolvedLogin: null } } }), v010],
    good: [esm("good"), v010],
  };
  const targets = Object.values(cases).map(([t]) => t);
  const bares = {};
  const seeds = {};
  for (const [t, release, mutate] of Object.values(cases)) {
    ({ bare: bares[t.repository], seed: seeds[t.name] } = consumerFixture(t, release, mutate));
  }
  // A human-authored commit already on the update branch.
  g(seeds.foreign, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(seeds.foreign, "README.md"), "human edit\n");
  g(seeds.foreign, "commit", "--quiet", "-am", "human");
  g(seeds.foreign, "push", "--quiet", "origin", branch);
  const api = fakePulls(bares);
  api.pulls.push({ repo: "michaeltorbert/closed", number: 99, state: "closed", head: { ref: branch, sha: "0".repeat(40) }, base: { ref: "main" } });

  const before = Object.fromEntries(targets.map((t) => [t.name, heads(bares[t.repository])]));
  const report = await updater({ source, server, targets, bares, api });
  const states = Object.fromEntries(report.targets.map((t) => [t.name, t.state]));
  assert.deepEqual(states, {
    pending: "pending-bootstrap-merge",
    ahead: "downgrade-refused",
    edited: "vendor-invalid",
    foreign: "branch-conflict",
    closed: "closed-pr-exists",
    failing: "error",
    "tampered-checker": "checker-mismatch",
    "tampered-safety": "pre-commit-mismatch",
    "exact-safety": "pr-opened",
    "codex-only": "unsupported-author",
    good: "pr-opened",
  });
  assert.equal(report.ok, false, "a partial failure fails the run");
  assert.equal(byName(report).pending.ok, true);
  for (const name of ["pending", "ahead", "edited", "foreign", "closed", "failing", "tampered-checker", "tampered-safety", "codex-only"]) {
    assert.equal(heads(bares[`michaeltorbert/${name}`]), before[name], `${name} left untouched`);
  }
  assert.deepEqual(api.pulls.filter((p) => p.number !== 99).map((p) => p.repo).sort(), ["michaeltorbert/exact-safety", "michaeltorbert/good"]);

  // Fetched consumer code never runs unless it is the exact reviewed script.
  assert.equal(existsSync(marker("checker")), false, "a changed fetched checker is never executed");
  assert.equal(existsSync(marker("tampered")), false, "a changed safety script is never executed");
  assert.equal(readFileSync(marker("exact"), "utf8"), "ran\nran\n", "the exact reviewed script runs before commit and before push");
});

test("updater refuses a release whose asset or tag no longer matches", async () => {
  const source = sourceFixture();
  const server = await releaseServer();
  source.commit("0.1.0");
  source.tag("0.1.0");
  source.commit("0.1.1");
  source.tag("0.1.1");
  server.publish(source.release("0.1.0"));
  server.publish(source.release("0.1.1"));
  const t = target("app", "src/vendor/home-screen-install", "esm");
  const bares = { [t.repository]: consumerFixture(t, source.release("0.1.0")).bare };
  const api = fakePulls(bares);
  const before = heads(bares[t.repository]);

  const asset = `/download/v0.1.1/${FORMAT_FILES.esm}`;
  const original = server.assets.get(asset);
  server.assets.set(asset, Buffer.concat([original, Buffer.from("\n")]));
  let report = await updater({ source, server, targets: [t], bares, api });
  assert.equal(report.targets[0].state, "release-invalid");
  assert.match(report.targets[0].detail, /does not match release-manifest\.json/);
  server.assets.set(asset, original);

  // Move the published tag to a different commit with identical version files.
  source.commit("0.1.1", " (retagged)");
  source.tag("0.1.1", source.commits["0.1.1"], true);
  report = await updater({ source, server, targets: [t], bares, api });
  assert.equal(report.targets[0].state, "release-invalid");
  assert.match(report.targets[0].detail, /tag resolves to/);
  assert.equal(report.ok, false);
  assert.equal(heads(bares[t.repository]), before);
  assert.equal(api.pulls.length, 0);
});

test("release publisher verifies a draft before publishing and never overwrites or moves a tag", async () => {
  const source = sourceFixture();
  const commit = source.commit("0.1.0");
  const state = { releases: [], ops: [], corrupt: null, nextId: 1 };
  const find = (id) => state.releases.find((r) => r.id === id);
  const api = {
    async getReleaseByTag(repo, tag) {
      return state.releases.find((r) => r.tag_name === tag && !r.draft) || null;
    },
    async listReleases() {
      return state.releases.map((r) => ({ tag_name: r.tag_name, draft: r.draft }));
    },
    async createRelease(repo, body) {
      state.ops.push("create");
      const id = state.nextId++;
      state.releases.push({ id, ...body, author: { login: "claude-bot-mt[bot]" }, upload_url: `https://uploads.example.invalid/${id}/assets{?name,label}`, html_url: `https://example.invalid/${body.tag_name}`, assets: [] });
      return { ...find(id) };
    },
    async uploadAsset(url, name, file) {
      state.ops.push(`upload ${name}`);
      const bytes = readFileSync(file);
      find(Number(/\/(\d+)\/assets/.exec(url)[1])).assets.push({ id: state.nextId++, name, bytes: state.corrupt === name ? Buffer.concat([bytes, Buffer.from("x")]) : bytes });
    },
    // Metadata only, as GitHub reports it for stored bytes; drafts are never downloaded.
    async listAssets(repo, id) {
      return find(id).assets.map((a) => ({ id: a.id, name: a.name, state: "uploaded", size: a.bytes.length, digest: `sha256:${sha256(a.bytes)}` }));
    },
    async updateRelease(repo, id, body) {
      state.ops.push("publish");
      Object.assign(find(id), body);
      return { ...find(id) };
    },
  };
  const publicSource = {
    ...createPublicSource({ repository: SOURCE_REPO, scratch, gitUrl: `file://${source.bare}` }),
    async listReleases() {
      return state.releases.filter((r) => !r.draft).map((r) => ({ ...r, assets: r.assets.map((a) => ({ name: a.name, browser_download_url: String(a.id) })) }));
    },
    async download(id) {
      return state.releases.flatMap((r) => r.assets).find((a) => a.id === Number(id)).bytes;
    },
  };
  // A file:// remote never asks for credentials; the helper only has to be named.
  const publish = (extra = {}) => publishRelease({ root: source.work, source: consumers.source, aiAuthor: "claude", api, publicSource, credentialHelper: "/bin/false", remoteUrl: source.url, checkDist: () => [], log: () => {}, ...extra });
  const remoteTag = () => g(source.work, "ls-remote", source.bare, "refs/tags/v0.1.0").split("\t")[0];

  // Repository config that could reroute credentials, headers or URLs is refused before any remote access.
  for (const [key, value] of [
    ["http.https://github.com/.extraheader", "AUTHORIZATION: basic personal"],
    ["credential.https://github.com/michaeltorbert.helper", "/personal/helper"],
    ["credential.username", "personal"],
    ["url.https://personal@github.com/.insteadOf", "https://github.com/"],
  ]) {
    g(source.work, "config", key, value);
    await assert.rejects(publish({ dryRun: true }), /refusing repository git config/, key);
    g(source.work, "config", "--unset", key);
  }

  const plan = await publish({ dryRun: true });
  assert.equal(plan.commit, commit);
  assert.deepEqual(state.ops, []);
  assert.equal(remoteTag(), "");

  state.corrupt = CHECKSUMS;
  await assert.rejects(publish(), /uploaded SHA256SUMS differs or has no sha256 digest; draft 1 left unpublished/);
  assert.equal(state.releases[0].draft, true);
  assert.ok(!state.ops.includes("publish"));
  assert.equal(remoteTag(), commit);

  state.releases = [];
  state.ops = [];
  state.corrupt = null;
  const result = await publish();
  assert.deepEqual(state.ops, ["create", ...["home-screen-install.js", "home-screen-install.mjs", CHECKSUMS, "release-manifest.json"].map((n) => `upload ${n}`), "publish"]);
  assert.equal(result.commit, commit);
  assert.equal(result.immutable, null);
  const manifest = JSON.parse(state.releases[0].assets.find((a) => a.name === "release-manifest.json").bytes);
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.aiAuthor, "claude");

  await assert.rejects(publish(), /already published/);
  source.commit("0.1.0", " (changed)");
  await assert.rejects(publish(), /already points at/);
  assert.equal(remoteTag(), commit, "tag not moved");
  assert.equal(state.ops.filter((op) => op === "create").length, 1);
});

/** Runs scripts/lib/github.mjs pushTag in a worker thread; resolves { ok, message }. */
function pushTagInWorker(options, env) {
  const moduleUrl = pathToFileURL(join(ROOT, "scripts/lib/github.mjs")).href;
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     import(workerData.moduleUrl).then(({ pushTag }) => {
       try {
         pushTag(workerData.options);
         parentPort.postMessage({ ok: true });
       } catch (error) {
         parentPort.postMessage({ ok: false, message: error.message });
       }
     });`,
    { eval: true, workerData: { moduleUrl, options }, env }
  );
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`push worker exited (${code}) without a result`)));
  });
}

test("release tag push authenticates only through the mapped App helper, whatever the repository config says", { timeout: 120_000 }, async () => {
  const source = sourceFixture();
  const commit = source.commit("0.1.0");
  const dir = fresh("push-isolation");
  const script = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}`);
    chmodSync(path, 0o755);
    return path;
  };
  // "Personal" routes log any use; the mapped App helper hands out a fake token.
  const personal = script("personal-helper", `echo "$@" >> "${dir}/personal.log"\necho username=personal\necho password=personal-secret\n`);
  const askpass = script("personal-askpass", `echo askpass >> "${dir}/personal.log"\necho personal-secret\n`);
  const mapped = script("app-helper", `echo "$@" >> "${dir}/app.log"\nif [ "$2" = get ]; then echo username=x-access-token; echo password=app-fake; fi\n`);

  // Loopback remote that always demands Basic auth and records every request's headers.
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
    res.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/michaeltorbert/home-screen-install.git`;

  // Repository-local routing that a plain `git push` would use, plus an inherited askpass.
  g(source.work, "config", "--add", "credential.helper", personal);
  g(source.work, "config", "--add", `credential.${origin}.helper`, personal);
  g(source.work, "config", `http.${origin}.extraHeader`, "X-Personal: leaked");
  g(source.work, "config", "core.askPass", askpass);

  // pushTag runs git synchronously, which would block this thread's event loop
  // and with it the loopback server. Run the exported pushTag in a worker so the
  // server keeps answering. The low-speed settings make git give up instead of
  // hanging if the server ever stops answering; they do not affect routing.
  const outcome = await pushTagInWorker(
    { cwd: source.work, url, commit, tag: "v0.1.0", helper: mapped, profile: "claude" },
    { ...process.env, GIT_ASKPASS: askpass, GIT_HTTP_LOW_SPEED_LIMIT: "1", GIT_HTTP_LOW_SPEED_TIME: "20" }
  );
  assert.equal(outcome.ok, false, "the fixture remote rejects every credential");
  assert.match(outcome.message, /git push failed \(exit/);

  assert.equal(existsSync(join(dir, "personal.log")), false, "no repository helper or askpass ran");
  assert.match(readFileSync(join(dir, "app.log"), "utf8"), /^claude get\n/, "the mapped helper ran with the source profile");
  const auth = seen.map((headers) => headers.authorization).filter(Boolean);
  assert.ok(auth.length > 0, "git retried with credentials");
  assert.deepEqual([...new Set(auth)], [`Basic ${Buffer.from("x-access-token:app-fake").toString("base64")}`]);
  assert.ok(seen.every((headers) => !("x-personal" in headers)), "no inherited extra header was sent");
  assert.equal(g(source.bare, "tag"), "", "nothing was pushed");
});

test("App requests leave Accept, version and auth headers to the wrapper and parse its output", async () => {
  // Stand-in for github-app-curl: records its arguments and stdin, then prints a body and the -w status.
  const dir = fresh("fake-curl");
  const curl = join(dir, "github-app-curl");
  writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\nprintf '%s\\n%s' "$HSI_FAKE_BODY" "$HSI_FAKE_STATUS"\n`);
  chmodSync(curl, 0o755);
  const api = createAppApi("claude", { curl });
  const reply = (status, body) => Object.assign(process.env, { HSI_FAKE_STATUS: String(status), HSI_FAKE_BODY: body });
  const sent = () => readFileSync(join(dir, "args"), "utf8").split("\n").slice(0, -1);
  const headers = (args) => args.filter((arg, i) => args[i - 1] === "-H");

  try {
    reply(201, '{"number":5}');
    assert.deepEqual(await api.createPull("michaeltorbert/x", { title: "t" }), { number: 5 });
    let args = sent();
    assert.deepEqual(args.slice(0, 2), ["--profile", "claude"]);
    assert.deepEqual(headers(args), ["Content-Type: application/json"], "no duplicate Accept, X-GitHub-Api-Version or Authorization");
    assert.ok(args.includes("--data-binary") && args.includes("@-") && !args.includes("-L"));
    assert.equal(args.at(-1), "https://api.github.com/repos/michaeltorbert/x/pulls");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "stdin"), "utf8")), { title: "t" });

    reply(404, '{"message":"Not Found"}');
    assert.equal(await api.getReleaseByTag("michaeltorbert/x", "v1.0.0"), null);
    args = sent();
    assert.deepEqual(headers(args), []);
    assert.ok(args.includes("-L"));
    assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "");

    const file = join(dir, "asset.bin");
    writeFileSync(file, Buffer.from([0, 1, 2]));
    reply(201, '{"id":9}');
    await api.uploadAsset("https://uploads.github.com/repos/michaeltorbert/x/releases/3/assets{?name,label}", "SHA256SUMS", file);
    args = sent();
    assert.deepEqual(headers(args), ["Content-Type: application/octet-stream"]);
    assert.ok(args.includes(`@${file}`));
    assert.equal(args.at(-1), "https://uploads.github.com/repos/michaeltorbert/x/releases/3/assets?name=SHA256SUMS");

    reply(400, '{"message":"Bad Request"}');
    await assert.rejects(api.listReleases("michaeltorbert/x"), /list releases: HTTP 400: Bad Request/);
  } finally {
    delete process.env.HSI_FAKE_STATUS;
    delete process.env.HSI_FAKE_BODY;
  }
});

test("installed runner is pinned by its manifest hash and its imports stay inside the pinned files", () => {
  const dir = fresh("runner");
  for (const path of RUNNER_FILES) writeTree(dir, { [path]: readFileSync(join(ROOT, path)) });
  for (const path of RUNNER_FILES.filter((p) => p.endsWith(".mjs"))) {
    for (const [, spec] of readFileSync(join(ROOT, path), "utf8").matchAll(/^import [^;]*? from "([^"]+)";/gms)) {
      if (spec.startsWith("node:")) continue;
      assert.ok(RUNNER_FILES.includes(posix.normalize(posix.join(posix.dirname(path), spec))), `${path} imports ${spec} outside the runner`);
    }
  }
  const manifest = canonicalJson({ schema: 1, commit: "a".repeat(40), files: hashTree(dir) });
  writeFileSync(join(dir, RUNNER_MANIFEST), manifest);
  const digest = sha256(Buffer.from(manifest));
  assert.equal(verifyRunner(dir, digest), "a".repeat(40));
  assert.throws(() => verifyRunner(dir, undefined), /not set/);
  assert.throws(() => verifyRunner(dir, "0".repeat(64)), /manifest hash/);
  const updater = join(dir, "scripts/update-consumers.mjs");
  const original = readFileSync(updater);
  writeFileSync(updater, Buffer.concat([original, Buffer.from("// changed\n")]));
  assert.throws(() => verifyRunner(dir, digest), /differ/);
  writeFileSync(updater, original);
  writeFileSync(join(dir, "scripts/extra.mjs"), "");
  assert.throws(() => verifyRunner(dir, digest), /differ/);

  const values = { LABEL: "label", NODE: "/opt/node", RUNNER_DIR: "/a & <b>", STATE_DIR: "/state", PATH: "/usr/bin:/bin", MANIFEST_SHA256: digest, HOUR: 9, MINUTE: 17, LOG_DIR: "/logs" };
  const plist = renderPlist(readFileSync(join(ROOT, TEMPLATE), "utf8"), values);
  assert.ok(plist.includes("<string>/a &amp; &lt;b&gt;/scripts/update-consumers.mjs</string>"));
  assert.ok(plist.includes("<string>--live</string>") && plist.includes("<string>--scheduled</string>"));
  assert.ok(plist.includes(`<string>${digest}</string>`));
  assert.doesNotMatch(plist, /\{\{|token|private.?key|\.pem/i);
  const { HOUR, ...missing } = values;
  assert.throws(() => renderPlist(readFileSync(join(ROOT, TEMPLATE), "utf8"), missing), /HOUR/);
});
