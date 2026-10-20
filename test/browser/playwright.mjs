// Loads the Playwright library: PLAYWRIGHT_MODULE (absolute file or package
// directory) when set, otherwise an importable "playwright" or "playwright-core".

import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_MODULE;
  let mod;
  if (spec) {
    if (!isAbsolute(spec)) throw new Error("PLAYWRIGHT_MODULE must be an absolute path");
    mod = statSync(spec).isDirectory()
      ? createRequire(join(spec, "package.json"))(spec)
      : await import(pathToFileURL(spec).href);
  } else {
    try {
      mod = await import("playwright");
    } catch {
      mod = await import("playwright-core");
    }
  }
  const playwright = mod.chromium ? mod : mod.default;
  if (!playwright?.chromium || !playwright?.webkit) throw new Error("Could not load the Playwright library");
  return playwright;
}
