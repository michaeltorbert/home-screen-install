#!/usr/bin/env node
// Offline integrity check for a vendored copy of home-screen-install.
//
// This file is copied byte-for-byte into each consumer repository as
// .github/scripts/check-home-screen-install.mjs and is also the verifier used by
// the source repository's stage and update commands. It reads only local files,
// uses only Node built-ins and never touches the network.
//
//   node check-home-screen-install.mjs <vendor-dir> <classic|esm>

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE = "home-screen-install";
export const SOURCE = "https://github.com/michaeltorbert/home-screen-install";
export const FORMAT_FILES = Object.freeze({ classic: "home-screen-install.js", esm: "home-screen-install.mjs" });
export const CHECKSUMS = "SHA256SUMS";
export const LOCK = "home-screen-install.lock.json";
export const LOCK_KEYS = Object.freeze(["schema", "package", "source", "version", "tag", "commit", "format", "file", "sha256"]);
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Parses `shasum -a 256` output into Map<file name, hex digest>. */
export function parseChecksums(text) {
  if (!text.endsWith("\n")) throw new Error(`${CHECKSUMS} must end with a newline`);
  const sums = new Map();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) throw new Error(`${CHECKSUMS} has a malformed line ${JSON.stringify(line)}`);
    if (sums.has(match[2])) throw new Error(`${CHECKSUMS} lists ${match[2]} twice`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/** Canonical lock text: fixed key order, two-space indent, trailing newline. */
export function serializeLock(lock) {
  return JSON.stringify(Object.fromEntries(LOCK_KEYS.map((key) => [key, lock[key]])), null, 2) + "\n";
}

/**
 * Verifies a vendored payload (Map<file name, Buffer>) for the expected format.
 * Returns the parsed lock, or throws an Error naming the first problem.
 */
export function checkPayload(files, format) {
  const file = FORMAT_FILES[format];
  if (!Object.hasOwn(FORMAT_FILES, format)) throw new Error(`unknown format ${JSON.stringify(format)}; expected classic or esm`);
  const expected = [CHECKSUMS, file, LOCK].sort();
  const names = [...files.keys()].sort();
  if (names.join("\n") !== expected.join("\n")) {
    throw new Error(`expected exactly ${expected.join(", ")}; found ${names.join(", ") || "nothing"}`);
  }

  const lockText = files.get(LOCK).toString("utf8");
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    throw new Error(`${LOCK} is not valid JSON`);
  }
  if (lock === null || typeof lock !== "object" || Array.isArray(lock) || serializeLock(lock) !== lockText) {
    throw new Error(`${LOCK} is not in canonical form (keys ${LOCK_KEYS.join(", ")})`);
  }
  if (lock.schema !== 1) throw new Error(`${LOCK} schema must be 1`);
  if (lock.package !== PACKAGE || lock.source !== SOURCE) throw new Error(`${LOCK} names an unexpected package or source`);
  if (typeof lock.version !== "string" || !STABLE_VERSION.test(lock.version)) throw new Error(`${LOCK} version is not a stable semver`);
  if (lock.tag !== `v${lock.version}`) throw new Error(`${LOCK} tag must be v${lock.version}`);
  if (typeof lock.commit !== "string" || !/^[0-9a-f]{40}$/.test(lock.commit)) throw new Error(`${LOCK} commit must be a full 40-character SHA`);
  if (lock.format !== format || lock.file !== file) throw new Error(`${LOCK} must record format ${format} and file ${file}`);

  const script = files.get(file);
  const digest = sha256(script);
  if (lock.sha256 !== digest) throw new Error(`${file} does not match the sha256 recorded in ${LOCK}`);
  if (parseChecksums(files.get(CHECKSUMS).toString("utf8")).get(file) !== digest) {
    throw new Error(`${file} does not match its ${CHECKSUMS} entry`);
  }
  if (!script.toString("utf8").startsWith(`/*! ${PACKAGE} v${lock.version} |`)) {
    throw new Error(`${file} banner does not name v${lock.version}`);
  }
  return lock;
}

/** Reads a vendor directory into Map<file name, Buffer>; only regular files are allowed. */
export function readVendorDir(dir) {
  if (!existsSync(dir)) throw new Error("vendor directory not found");
  const files = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (!lstatSync(join(dir, name)).isFile()) throw new Error(`${name} is not a regular file`);
    files.set(name, readFileSync(join(dir, name)));
  }
  return files;
}

function main(args) {
  if (args.length !== 2) {
    console.error("usage: node check-home-screen-install.mjs <vendor-dir> <classic|esm>");
    process.exitCode = 2;
    return;
  }
  const [dir, format] = args;
  try {
    const lock = checkPayload(readVendorDir(resolve(dir)), format);
    console.log(`home-screen-install v${lock.version} (${format}) verified in ${dir}: sha256 ${lock.sha256}, source commit ${lock.commit}`);
  } catch (error) {
    console.error(`check-home-screen-install: ${dir}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
