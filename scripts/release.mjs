#!/usr/bin/env node
// Publishes the GitHub release for package.json's version from the clean,
// pushed HEAD, through the source repository's GitHub App profile.
//
//   node scripts/release.mjs --ai-author <claude|codex|human> --dry-run|--publish
//
// Order: verify locally -> push the tag (never moved) -> draft release ->
// upload the four assets -> check GitHub's size and sha256 digest for each ->
// publish -> download the public assets anonymously and compare bytes. An existing release or draft for the tag is never
// overwritten. A failure after the draft exists leaves an unpublished draft,
// which the updater ignores; inspect and delete it before retrying.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { staleArtifacts } from "./build.mjs";
import {
  AI_AUTHORS,
  CHECKSUMS,
  FORMAT_FILES,
  MANIFEST,
  RELEASE_ASSETS,
  ROOT,
  buildManifest,
  git,
  loadConsumers,
  peeledTag,
  releaseFromTree,
  requireClean,
  sha256,
  treeReader,
} from "./lib/distribution.mjs";
import { appPushArgs, appSlug, assertIsolatedRemoteConfig, createAppApi, createPublicSource, findExecutable, pushTag } from "./lib/github.mjs";

/** The CHANGELOG section for `version` (heading `## x.y.z`), without the heading. */
export function changelogSection(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `## ${version}`);
  if (start < 0) throw new Error(`release: CHANGELOG.md has no "## ${version}" heading`);
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

export function releaseAssets(release, aiAuthor) {
  return new Map([
    [FORMAT_FILES.classic, release.files.classic],
    [FORMAT_FILES.esm, release.files.esm],
    [CHECKSUMS, release.files.sums],
    [MANIFEST, buildManifest(release, aiAuthor)],
  ]);
}

/**
 * options: { root, source: { repository, defaultBranch, profile, actor }, aiAuthor,
 *            api, publicSource, credentialHelper, dryRun, checkDist, log, remoteUrl }
 * `remoteUrl` exists for local fixtures; it defaults to the source repository.
 */
export async function publishRelease(options) {
  const { root = ROOT, source, aiAuthor, api, publicSource, credentialHelper, dryRun, log = console.log } = options;
  const checkDist = options.checkDist || (() => staleArtifacts(root));
  const repo = source.repository;
  const expectedUrl = `https://github.com/${repo}.git`;
  const remoteUrl = options.remoteUrl || expectedUrl;

  const commit = requireClean(root, "release");
  const origin = git(["config", "--get", "remote.origin.url"], { cwd: root }).text;
  if (origin !== expectedUrl) throw new Error(`release: origin is ${origin}, not ${repo}`);
  // Git traffic goes to the explicit URL, never through remote or URL-rewrite
  // config, and only the mapped App helper can supply credentials for it.
  assertIsolatedRemoteConfig(root, remoteUrl);
  const remoteArgs = appPushArgs(remoteUrl, credentialHelper, source.profile);
  const stale = checkDist();
  if (stale.length) throw new Error(`release: generated files are stale: ${stale.join(", ")}`);
  const read = treeReader(root, commit);
  const release = releaseFromTree(read, commit);
  const notes = changelogSection(read("CHANGELOG.md").toString("utf8"), release.version);
  const assets = releaseAssets(release, aiAuthor);
  const tag = release.tag;

  const main = git([...remoteArgs, "ls-remote", remoteUrl, `refs/heads/${source.defaultBranch}`], { cwd: root }).text.split("\t")[0];
  if (main !== commit) throw new Error(`release: HEAD ${commit} is not the pushed ${source.defaultBranch} (${main || "missing"})`);
  const lsTag = () => peeledTag(git([...remoteArgs, "ls-remote", remoteUrl, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root }).text, tag);
  const existingTag = lsTag();
  if (existingTag && existingTag !== commit) throw new Error(`release: ${tag} already points at ${existingTag}; tags are never moved`);
  if (await api.getReleaseByTag(repo, tag)) throw new Error(`release: ${tag} is already published; releases are never overwritten`);
  if ((await api.listReleases(repo)).some((r) => r.tag_name === tag)) throw new Error(`release: a draft for ${tag} already exists; inspect it first`);

  const plan = { tag, commit, aiAuthor, assets: Object.fromEntries([...assets].map(([name, bytes]) => [name, sha256(bytes)])) };
  if (dryRun) {
    log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    return { dryRun: true, ...plan };
  }

  if (!existingTag) pushTag({ cwd: root, url: remoteUrl, commit, tag, helper: credentialHelper, profile: source.profile });
  if (lsTag() !== commit) throw new Error(`release: ${tag} does not resolve to ${commit} after pushing`);

  const draft = await api.createRelease(repo, { tag_name: tag, target_commitish: commit, name: tag, body: notes, draft: true, prerelease: false });
  if (draft.author?.login !== source.actor) throw new Error(`release: draft ${draft.id} was created by ${draft.author?.login}; left unpublished`);
  const stage = mkdtempSync(join(tmpdir(), "hsi-release-"));
  try {
    for (const [name, bytes] of assets) {
      const file = join(stage, name);
      writeFileSync(file, bytes);
      await api.uploadAsset(draft.upload_url, name, file);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const uploaded = await api.listAssets(repo, draft.id);
  if (uploaded.map((a) => a.name).sort().join() !== [...RELEASE_ASSETS].sort().join()) {
    throw new Error(`release: draft ${draft.id} has assets ${uploaded.map((a) => a.name).join(", ")}; left unpublished`);
  }
  // Draft assets are only readable with authentication, and the App wrapper can
  // make JSON requests only, so the draft is checked against GitHub's own
  // per-asset sha256 digest. A missing digest fails closed. Published bytes are
  // downloaded and compared again, anonymously, below.
  for (const asset of uploaded) {
    const bytes = assets.get(asset.name);
    if (asset.state !== "uploaded" || asset.size !== bytes.length || asset.digest !== `sha256:${sha256(bytes)}`) {
      throw new Error(`release: uploaded ${asset.name} differs or has no sha256 digest; draft ${draft.id} left unpublished`);
    }
  }

  const published = await api.updateRelease(repo, draft.id, { draft: false });
  if (published.draft !== false || published.tag_name !== tag) throw new Error(`release: publishing draft ${draft.id} did not take effect`);

  // Verify what anonymous readers (and the updater) will actually see.
  const live = (await publicSource.listReleases()).find((r) => r.tag_name === tag);
  if (!live || live.draft || live.prerelease || live.author?.login !== source.actor) throw new Error(`release: public ${tag} is missing or unexpected`);
  for (const asset of live.assets) {
    const expected = assets.get(asset.name);
    if (!expected || !(await publicSource.download(asset.browser_download_url)).equals(expected)) {
      throw new Error(`release: public asset ${asset.name} does not match`);
    }
  }
  if (live.assets.length !== assets.size) throw new Error("release: public asset count differs");
  if (publicSource.resolveTag(tag) !== commit) throw new Error(`release: public ${tag} does not resolve to ${commit}`);
  const result = { ...plan, release: live.html_url, author: live.author.login, immutable: live.immutable ?? null };
  log(JSON.stringify(result, null, 2));
  return result;
}

async function main(args) {
  let aiAuthor;
  let mode;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ai-author") aiAuthor = args[++i];
    else if ((args[i] === "--dry-run" || args[i] === "--publish") && !mode) mode = args[i];
    else mode = "bad";
  }
  if (!AI_AUTHORS.includes(aiAuthor) || !mode || mode === "bad") {
    console.error(`usage: node scripts/release.mjs --ai-author <${AI_AUTHORS.join("|")}> --dry-run|--publish`);
    return 2;
  }
  const scratch = mkdtempSync(join(tmpdir(), "hsi-release-source-"));
  try {
    const { source } = loadConsumers();
    const slug = appSlug(source.profile);
    if (slug !== source.appSlug) throw new Error(`release: profile ${source.profile} resolves to ${slug}, expected ${source.appSlug}`);
    await publishRelease({
      source,
      aiAuthor,
      api: createAppApi(source.profile),
      publicSource: createPublicSource({ repository: source.repository, scratch }),
      credentialHelper: findExecutable("git-credential-github-app"),
      dryRun: mode === "--dry-run",
    });
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
