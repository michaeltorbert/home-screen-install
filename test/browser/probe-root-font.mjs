#!/usr/bin/env node
// Diagnostic probe, not part of the acceptance suite: how each engine updates
// font sizes inside shadow trees when the root font-size changes after first
// render. Uses page.setContent (no server, no network) and prints JSON only.
//
//   [PLAYWRIGHT_MODULE=/abs/path] [HSI_CHROMIUM_CHANNEL=chrome] node test/browser/probe-root-font.mjs
//
// Variants:
//   shadowRem       shadow stylesheet: font-size: 1rem
//   shadowVarRem    shadow stylesheet: font-size: var(--x, 1rem)        (0.1.0 before the fix)
//   hostInlineVar   host inline var(--x, 1rem), shadow font-size: 100%  (pattern used by the fix)
//   lightRem        ordinary document element with font-size: 1rem
//   component       the built dist/home-screen-install.js button

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "../../demo/serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const FIXTURE = `<!doctype html>
<html><head><style>.light { font-size: 1rem; }</style></head>
<body><span class="light" id="lightRem">light</span><div id="hosts"></div><div id="component"></div></body></html>`;

function buildVariants() {
  const hosts = document.getElementById("hosts");
  const make = (id, css, inlineSize) => {
    const host = document.createElement("div");
    host.id = id;
    if (inlineSize) host.style.setProperty("font-size", inlineSize);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    const text = document.createElement("span");
    text.className = "t";
    text.textContent = id;
    root.append(style, text);
    hosts.append(host);
  };
  make("shadowRem", ".t { font-size: 1rem; }");
  make("shadowVarRem", ".t { font-size: var(--x, 1rem); }");
  make("hostInlineVar", ".t { font-size: 100%; }", "var(--x, 1rem)");
  window.HomeScreenInstall.mount(document.getElementById("component"), { appName: "Probe" });
}

function readSizes() {
  const size = (node) => parseFloat(getComputedStyle(node).fontSize);
  const inner = (id) => size(document.getElementById(id).shadowRoot.querySelector(".t"));
  return {
    root: size(document.documentElement),
    shadowRem: inner("shadowRem"),
    shadowVarRem: inner("shadowVarRem"),
    hostInlineVar: inner("hostInlineVar"),
    lightRem: size(document.getElementById("lightRem")),
    component: size(document.querySelector("#component [data-home-screen-install]").shadowRoot.querySelector(".trigger")),
  };
}

async function probe(type, options) {
  const browser = await type.launch(options);
  try {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    await page.addScriptTag({ content: readFileSync(join(ROOT, "dist/home-screen-install.js"), "utf8") });
    await page.evaluate(buildVariants);
    const before = await page.evaluate(readSizes);
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "html { font-size: 200% !important; }";
      document.head.append(style);
    });
    const immediately = await page.evaluate(readSizes);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const afterTwoFrames = await page.evaluate(readSizes);
    return { engine: browser.version(), before, immediately, afterTwoFrames };
  } finally {
    await browser.close();
  }
}

const playwright = await loadPlaywright();
const chromiumOptions = { headless: true, args: ["--mute-audio"] };
if (process.env.HSI_CHROMIUM_CHANNEL) chromiumOptions.channel = process.env.HSI_CHROMIUM_CHANNEL;
const report = {
  chromium: await probe(playwright.chromium, chromiumOptions),
  webkit: await probe(playwright.webkit, { headless: true }),
};
console.log(JSON.stringify(report, null, 2));
