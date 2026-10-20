#!/usr/bin/env node
// Diagnostic probe, not part of the acceptance suite: where focus goes inside
// the open guide for fixed key sequences, in Chromium and WebKit. Separates a
// reverse-Tab problem from side effects of a browser shortcut (Alt+ArrowDown).
// Uses the classic demo at 320x568 with 200% root text, served on an ephemeral
// 127.0.0.1 port; prints JSON only and writes nothing.
//
//   [PLAYWRIGHT_MODULE=/abs/path] [HSI_CHROMIUM_CHANNEL=chrome] node test/browser/probe-reverse-tab.mjs

import { createDemoServer } from "../../demo/serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const SEQUENCES = {
  tabThenShiftTab: ["Tab", "Shift+Tab"],
  scrollKeysThenShiftTab: ["Tab", "End", "Home", "Shift+Tab"],
  altArrowDownThenShiftTab: ["Tab", "Alt+ArrowDown", "Shift+Tab"],
  forwardTabCycle: ["Tab", "Tab", "Tab", "Tab"],
  shiftTabFromClose: ["Shift+Tab", "Shift+Tab"],
};

function enlargeRootFont() {
  const add = () => {
    const style = document.createElement("style");
    style.textContent = "html { font-size: 200% !important; }";
    document.head.append(style);
  };
  if (document.head) return add();
  const observer = new MutationObserver(() => {
    if (document.head) {
      observer.disconnect();
      add();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

function focusState() {
  const host = document.querySelector("#install-slot > [data-home-screen-install]");
  const root = host.shadowRoot;
  const inner = root.activeElement;
  const outer = document.activeElement;
  const selection = typeof root.getSelection === "function" ? root.getSelection() : getSelection();
  return {
    documentActive: outer === host ? "component host" : outer ? outer.tagName.toLowerCase() + (outer.id ? `#${outer.id}` : "") : null,
    componentActive: inner ? inner.className || inner.tagName.toLowerCase() : null,
    dialogOpen: root.querySelector("dialog").open,
    scrollTop: Math.round(root.querySelector(".body").scrollTop),
    selection: selection
      ? {
          type: selection.type,
          text: selection.toString().slice(0, 60),
          anchor: selection.anchorNode ? `${selection.anchorNode.nodeName}: ${(selection.anchorNode.textContent || "").slice(0, 40)}` : null,
        }
      : null,
  };
}

async function runSequence(browser, origin, keys) {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
  await context.addInitScript(enlargeRootFont);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/demo/classic/`, { waitUntil: "load" });
    await page.waitForSelector('#status[data-state="ready"]');
    await page.locator("#install-slot button.trigger").click();
    await page.waitForTimeout(100);
    const steps = [{ key: "(opened by click)", ...(await page.evaluate(focusState)) }];
    for (const key of keys) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
      steps.push({ key, ...(await page.evaluate(focusState)) });
    }
    return steps;
  } finally {
    await context.close();
  }
}

const playwright = await loadPlaywright();
const server = createDemoServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { platform: process.platform };
try {
  const chromiumOptions = { headless: true, args: ["--mute-audio"] };
  if (process.env.HSI_CHROMIUM_CHANNEL) chromiumOptions.channel = process.env.HSI_CHROMIUM_CHANNEL;
  for (const [name, options] of [["chromium", chromiumOptions], ["webkit", { headless: true }]]) {
    const browser = await playwright[name].launch(options);
    try {
      report[name] = { version: browser.version(), sequences: {} };
      for (const [label, keys] of Object.entries(SEQUENCES)) {
        report[name].sequences[label] = await runSequence(browser, origin, keys);
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((done) => server.close(done));
}
console.log(JSON.stringify(report, null, 2));
