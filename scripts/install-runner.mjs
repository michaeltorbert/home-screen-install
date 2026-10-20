#!/usr/bin/env node
// Installs a pinned copy of the updater from this checkout's clean HEAD and
// writes its per-user LaunchAgent plist. It does not load the job, never pulls
// code later, and reads no credentials; the job verifies its own files against
// the manifest hash recorded in the plist before every run.
//
//   node scripts/install-runner.mjs --node <absolute node> --path <dir:dir:...>
//        [--hour 9] [--minute 17] [--state-dir <dir>] [--log-dir <dir>]
//        [--launch-agents-dir <dir>] [--replace]

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ROOT,
  RUNNER_FILES,
  RUNNER_MANIFEST,
  canonicalJson,
  hashTree,
  requireClean,
  sha256,
  sortedObject,
  treeReader,
  verifyRunner,
} from "./lib/distribution.mjs";
import { DEFAULT_STATE_DIR } from "./update-consumers.mjs";
import { findExecutable } from "./lib/github.mjs";

export const LABEL = "com.michaeltorbert.home-screen-install.updater";
export const TEMPLATE = "automation/home-screen-install-updater.plist.template";
const REQUIRED_TOOLS = ["git", "github-app-curl", "github-app-token", "git-credential-github-app"];
// macOS privacy (TCC) folders that a background job may be denied.
const PROTECTED = ["Documents", "Desktop", "Downloads"].map((name) => join(homedir(), name));

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderPlist(template, values) {
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`install: template value ${key} is missing`);
    return xml(values[key]);
  });
  return out;
}

export function installRunner({ root = ROOT, node, pathValue, hour = 9, minute = 17, stateDir = DEFAULT_STATE_DIR, logDir, launchAgentsDir, replace = false }) {
  logDir ||= join(homedir(), "Library", "Logs", "home-screen-install-updater");
  launchAgentsDir ||= join(homedir(), "Library", "LaunchAgents");
  if (!isAbsolute(node) || !existsSync(node)) throw new Error("install: --node must be an absolute path to node");
  const dirs = pathValue.split(":");
  if (!dirs.length || dirs.some((dir) => !isAbsolute(dir))) throw new Error("install: --path must list absolute directories");
  for (const tool of REQUIRED_TOOLS) findExecutable(tool, pathValue);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("install: bad time");
  for (const dir of [stateDir, logDir]) {
    if (PROTECTED.some((p) => `${dir}/`.startsWith(`${p}/`))) throw new Error(`install: ${dir} is inside a macOS privacy-protected folder`);
  }

  const commit = requireClean(root, "install");
  const read = treeReader(root, commit);
  const runnerDir = join(stateDir, "runner", commit);
  const files = Object.fromEntries(RUNNER_FILES.map((path) => [path, read(path)]));
  const expected = sortedObject(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)])));
  const manifest = Buffer.from(canonicalJson({ schema: 1, commit, files: expected }), "utf8");

  if (existsSync(runnerDir)) {
    // Reuse an existing install of the same commit only if it is byte-identical.
    if (canonicalJson(hashTree(runnerDir, [RUNNER_MANIFEST])) !== canonicalJson(expected) ||
        !readFileSync(join(runnerDir, RUNNER_MANIFEST)).equals(manifest)) {
      throw new Error(`install: ${runnerDir} exists with different contents; remove it deliberately first`);
    }
  } else {
    for (const [path, bytes] of Object.entries(files)) {
      const target = join(runnerDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      chmodSync(target, 0o444);
    }
    writeFileSync(join(runnerDir, RUNNER_MANIFEST), manifest);
    chmodSync(join(runnerDir, RUNNER_MANIFEST), 0o444);
  }
  const manifestSha = sha256(manifest);
  verifyRunner(runnerDir, manifestSha);

  mkdirSync(logDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  const plist = renderPlist(read(TEMPLATE).toString("utf8"), {
    LABEL,
    NODE: node,
    RUNNER_DIR: runnerDir,
    STATE_DIR: stateDir,
    PATH: pathValue,
    MANIFEST_SHA256: manifestSha,
    HOUR: hour,
    MINUTE: minute,
    LOG_DIR: logDir,
  });
  const plistPath = join(launchAgentsDir, `${LABEL}.plist`);
  if (existsSync(plistPath) && !readFileSync(plistPath, "utf8").includes(manifestSha) && !replace) {
    throw new Error(`install: ${plistPath} exists for another runner; boot it out and pass --replace`);
  }
  writeFileSync(plistPath, plist);
  return { commit, runnerDir, manifestSha256: manifestSha, plistPath, label: LABEL, logDir, stateDir };
}

function main(args) {
  const options = { replace: false };
  try {
    for (let i = 0; i < args.length; i++) {
      const value = () => {
        if (i + 1 >= args.length) throw new Error(`${args[i]} needs a value`);
        return args[++i];
      };
      switch (args[i]) {
        case "--node": options.node = value(); break;
        case "--path": options.pathValue = value(); break;
        case "--hour": options.hour = Number(value()); break;
        case "--minute": options.minute = Number(value()); break;
        case "--state-dir": options.stateDir = resolve(value()); break;
        case "--log-dir": options.logDir = resolve(value()); break;
        case "--launch-agents-dir": options.launchAgentsDir = resolve(value()); break;
        case "--replace": options.replace = true; break;
        default: throw new Error(`unknown argument ${args[i]}`);
      }
    }
    if (!options.node || !options.pathValue) throw new Error("--node and --path are required");
    const result = installRunner(options);
    console.log(JSON.stringify(result, null, 2));
    const domain = `gui/${process.getuid()}`;
    console.log(`\nNot loaded yet. To activate, run:\n  launchctl bootstrap ${domain} "${result.plistPath}"\n  launchctl print ${domain}/${LABEL}`);
    console.log(`Run once now:  launchctl kickstart ${domain}/${LABEL}`);
    console.log(`Disable:       launchctl bootout ${domain}/${LABEL}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
