#!/usr/bin/env node
// Writes one consumer's vendored payload (script, SHA256SUMS, lock) from the
// committed dist/ of this checkout's clean HEAD. Used to bootstrap the setup
// branches before the first release exists; the updater later produces the
// same bytes from the published release. Never commits or pushes.
//
//   node scripts/stage-consumer.mjs --target <name> --into <consumer checkout>

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { staleArtifacts } from "./build.mjs";
import {
  CHECKER_TEMPLATE,
  ROOT,
  buildPayload,
  checkPayload,
  git,
  loadConsumers,
  readVendorDir,
  releaseFromTree,
  requireClean,
  sha256,
  treeReader,
} from "./lib/distribution.mjs";

export function stageConsumer({ root = ROOT, consumers = loadConsumers(), target: name, into, checkDist = () => staleArtifacts(root) }) {
  const commit = requireClean(root, "stage");
  const stale = checkDist();
  if (stale.length) throw new Error(`stage: generated files are stale: ${stale.join(", ")}`);
  const read = treeReader(root, commit);
  const release = releaseFromTree(read, commit);

  const target = consumers.targets.find((t) => t.name === name);
  if (!target) throw new Error(`stage: unknown target ${name}`);
  const origin = git(["remote", "get-url", "origin"], { cwd: into }).text;
  if (![`https://github.com/${target.repository}.git`, `https://github.com/${target.repository}`].includes(origin)) {
    throw new Error(`stage: ${into} origin is ${origin}, not ${target.repository}`);
  }
  const checker = join(into, consumers.checker);
  if (!existsSync(checker) || !readFileSync(checker).equals(read(CHECKER_TEMPLATE))) {
    throw new Error(`stage: ${consumers.checker} in ${into} is missing or differs from ${CHECKER_TEMPLATE}`);
  }

  const files = buildPayload(release, target.format);
  const dir = join(into, target.path);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (!files.has(entry) || !lstatSync(join(dir, entry)).isFile()) throw new Error(`stage: refusing to overwrite unexpected ${target.path}/${entry}`);
    }
  }
  mkdirSync(dir, { recursive: true });
  for (const [file, bytes] of files) writeFileSync(join(dir, file), bytes);
  const lock = checkPayload(readVendorDir(dir), target.format);
  return { target: target.name, version: lock.version, commit, path: target.path, files: [...files].map(([file, bytes]) => ({ file, sha256: sha256(bytes) })) };
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--target") options.target = args[i + 1];
    else if (args[i] === "--into") options.into = args[i + 1] && resolve(args[i + 1]);
    else options.bad = args[i];
  }
  if (options.bad || !options.target || !options.into) {
    console.error("usage: node scripts/stage-consumer.mjs --target <name> --into <consumer checkout>");
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(stageConsumer(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
