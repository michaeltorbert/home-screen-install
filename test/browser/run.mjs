#!/usr/bin/env node
// Browser checks for both demos in Chromium and WebKit, driven by the
// Playwright library directly (not @playwright/test).
//
//   HSI_EVIDENCE_DIR=/absolute/dir/outside/this/package \
//   [PLAYWRIGHT_MODULE=/absolute/path/to/playwright] \
//   [HSI_CHROMIUM_CHANNEL=chrome] [HSI_BROWSERS=chromium,webkit] \
//   node test/browser/run.mjs
//
// The harness starts its own demo server on an ephemeral 127.0.0.1 port (never
// the native-demo port 8796), loads the demos (which consume the generated
// dist/ files), and writes results.json, summary.md and screenshots to
// HSI_EVIDENCE_DIR. It closes every browser and server it started.
//
// Checks whose names start with "INJECTED:" replace the two standalone signals
// inside the page with test values. They exercise the standalone code paths;
// they are not evidence of real Home Screen behavior, which needs a native
// device or simulator.
//
// Chromium runs with --mute-audio. Neither the component nor the demos contain
// audio; the checks below also assert there are no media elements.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { DEFAULT_PORT, ROOT, createDemoServer } from "../../demo/serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const DEMOS = [
  { id: "classic", path: "/demo/classic/", appName: "HSI Classic" },
  { id: "esm", path: "/demo/esm/", appName: "HSI ESM" },
];
const LABEL = "Add to Home Screen";
const QUERY = "(display-mode: standalone)";

// ---------------------------------------------------------------------------
// Setup

function evidenceDirectory() {
  const dir = process.env.HSI_EVIDENCE_DIR;
  if (!dir || !isAbsolute(dir)) throw new Error("Set HSI_EVIDENCE_DIR to an absolute directory outside the package.");
  const rel = relative(ROOT, resolve(dir));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`HSI_EVIDENCE_DIR must be outside ${ROOT}`);
  }
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  return resolve(dir);
}

// ---------------------------------------------------------------------------
// Result recording

const results = [];
const screenshots = [];
let evidenceDir;

async function check(scope, name, fn) {
  const entry = { browser: scope.browser, demo: scope.demo, name, injected: name.startsWith("INJECTED:"), status: "pass" };
  try {
    const detail = await fn();
    if (detail !== undefined) entry.detail = detail;
  } catch (error) {
    entry.status = "fail";
    entry.error = String(error?.stack ?? error);
  }
  results.push(entry);
  console.log(`${entry.status === "pass" ? "PASS" : "FAIL"} [${scope.browser}/${scope.demo}] ${name}`);
  if (entry.status === "fail") console.log(`     ${entry.error.split("\n").slice(0, 4).join("\n     ")}`);
}

async function screenshot(page, scope, label) {
  const file = `${scope.browser}-${scope.demo}-${label}.png`;
  // Let layout and painting settle (e.g. right after a viewport resize) so the
  // capture shows a finished frame.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: join(evidenceDir, "screenshots", file) });
  screenshots.push(file);
}

// ---------------------------------------------------------------------------
// Init scripts (run in the page before any demo script)

// Observation only: records the host's hidden state at the moment it is inserted.
function recordHostInsertions() {
  window.__hsiTestObserved = [];
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.hasAttribute("data-home-screen-install")) {
          window.__hsiTestObserved.push({ hidden: node.hidden, display: getComputedStyle(node).display });
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

// INJECTED: replaces navigator.standalone and the display-mode media query with
// controllable test values. Other media queries keep the real matchMedia.
function injectStandaloneSignals(initial) {
  const query = "(display-mode: standalone)";
  const state = { standalone: initial.standalone, matches: initial.matches };
  const listeners = new Set();
  const realMatchMedia = window.matchMedia.bind(window);
  const mql = {
    media: query,
    onchange: null,
    get matches() {
      return state.matches;
    },
    addEventListener(type, fn) {
      if (type === "change") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "change") listeners.delete(fn);
    },
    addListener(fn) {
      listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    dispatchEvent() {
      return true;
    },
  };
  window.matchMedia = (text) => (String(text).trim() === query ? mql : realMatchMedia(text));
  Object.defineProperty(navigator, "standalone", { configurable: true, get: () => state.standalone });
  window.__hsiTestInjected = {
    setDisplayMode(matches) {
      state.matches = matches;
      for (const fn of [...listeners]) fn({ type: "change", matches, media: query });
    },
    setNavigatorStandalone(value) {
      state.standalone = value;
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Page helpers

let origin;

async function openSession(
  browser,
  demo,
  { viewport = { width: 390, height: 844 }, hasTouch = false, inject = null, rootPercentAtLoad = null } = {}
) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch });
  await context.addInitScript(recordHostInsertions);
  if (inject) await context.addInitScript(injectStandaloneSignals, inject);
  if (rootPercentAtLoad) await context.addInitScript(enlargeRootFontAtLoad, rootPercentAtLoad);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const log = { console: [], pageErrors: [], requests: [], failed: [], badStatus: [], loadRequests: 0 };
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") log.console.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => log.pageErrors.push(String(error)));
  page.on("request", (req) => log.requests.push(req.url()));
  page.on("requestfailed", (req) => log.failed.push(`${req.url()} ${req.failure()?.errorText ?? ""}`));
  page.on("response", (res) => {
    if (res.status() >= 400) log.badStatus.push(`${res.status()} ${res.url()}`);
  });
  await page.goto(origin + demo.path, { waitUntil: "load" });
  await page.waitForSelector('#status:not([data-state="loading"])');
  log.loadRequests = log.requests.length;
  return { context, page, log };
}

const trigger = (page) => page.locator("#install-slot button.trigger");
const closeButton = (page) => page.locator("#install-slot button.close");

function uiState(page) {
  return page.evaluate(() => {
    const hosts = document.querySelectorAll("[data-home-screen-install]");
    const host = document.querySelector("#install-slot > [data-home-screen-install]");
    const root = host ? host.shadowRoot : null;
    const dialog = root ? root.querySelector("dialog") : null;
    const inner = root ? root.activeElement : null;
    const status = document.getElementById("status");
    let modal = null;
    try {
      modal = dialog ? dialog.matches(":modal") : null;
    } catch {
      modal = "unsupported";
    }
    return {
      hostCount: hosts.length,
      hostTag: host ? host.tagName : null,
      hidden: host ? host.hidden : null,
      hostDisplay: host ? getComputedStyle(host).display : null,
      shadowOpen: Boolean(root),
      dialogOpen: dialog ? dialog.open : null,
      modal,
      inner: inner ? inner.className || inner.tagName : null,
      docActive: document.activeElement === host ? "host" : document.activeElement ? document.activeElement.tagName : null,
      statusText: status.textContent,
      statusState: status.dataset.state,
      statusMode: status.dataset.mode ?? null,
      clicks: Number(document.getElementById("clicks-heard").textContent),
    };
  });
}

function waitForInner(page, className) {
  return page.waitForFunction((name) => {
    const host = document.querySelector("#install-slot > [data-home-screen-install]");
    const active = host && host.shadowRoot.activeElement;
    return Boolean(active && active.className === name);
  }, className);
}

function statusText(standalone) {
  return `Version ${pkg.version} · Mode: ${standalone ? "Home Screen" : "Browser"}`;
}

async function hygiene(scope, session, label) {
  await check(scope, `hygiene (${label}): no console errors, same-origin requests only, no storage or media`, async () => {
    const { page, log } = session;
    const stored = await page.evaluate(async () => {
      const out = {
        local: localStorage.length,
        session: sessionStorage.length,
        cookie: document.cookie,
      };
      out.indexedDB = indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : [];
      out.caches = self.caches ? await caches.keys() : [];
      out.serviceWorkers = navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0;
      let media = document.querySelectorAll("audio, video").length;
      for (const host of document.querySelectorAll("[data-home-screen-install]")) {
        media += host.shadowRoot.querySelectorAll("audio, video, iframe, img, link, script").length;
      }
      out.media = media;
      return out;
    });
    assert.deepEqual(log.pageErrors, [], "page errors");
    assert.deepEqual(log.console, [], "console errors/warnings");
    assert.deepEqual(log.failed, [], "failed requests");
    assert.deepEqual(log.badStatus, [], "HTTP error responses");
    const foreign = log.requests.filter((url) => !url.startsWith(`${origin}/`));
    assert.deepEqual(foreign, [], "requests to other origins");
    const late = log.requests.slice(log.loadRequests).filter((url) => !/\.webmanifest$|\/icons\/[^/]+$/.test(url));
    assert.deepEqual(late, [], "requests caused after load (the component makes none)");
    assert.deepEqual(stored, { local: 0, session: 0, cookie: "", indexedDB: [], caches: [], serviceWorkers: 0, media: 0 });
    return { requests: log.requests.length };
  });
}

async function rect(page, selector) {
  return page.evaluate((sel) => {
    const host = document.querySelector("#install-slot > [data-home-screen-install]");
    const node = host.shadowRoot.querySelector(sel);
    const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, selector);
}

// ---------------------------------------------------------------------------
// Suites

async function browserModeSuite(browser, scope, demo) {
  const session = await openSession(browser, demo);
  const { page } = session;
  try {
    await check(scope, "status shows the shipped VERSION and Browser mode after mount", async () => {
      const state = await uiState(page);
      assert.equal(state.statusState, "ready");
      assert.equal(state.statusMode, "browser");
      assert.equal(state.statusText, statusText(false));
      const version = await page.evaluate(() => window.__homeScreenInstallDemo.api.VERSION);
      assert.equal(version, pkg.version);
    });
    await screenshot(page, scope, "390x844-closed");

    await check(scope, "inserts exactly one owned shadow host, visible from first insertion", async () => {
      const state = await uiState(page);
      assert.equal(state.hostCount, 1);
      assert.equal(state.hostTag, "DIV", "a plain element, not a custom element");
      assert.equal(state.shadowOpen, true);
      assert.equal(state.hidden, false);
      const observed = await page.evaluate(() => window.__hsiTestObserved);
      assert.deepEqual(observed.map((entry) => entry.hidden), [false]);
      const lightChildren = await page.evaluate(() => document.querySelector("[data-home-screen-install]").childNodes.length);
      assert.equal(lightChildren, 0);
    });

    await check(scope, "button is a semantic, labeled, >=44px target", async () => {
      const button = page.getByRole("button", { name: LABEL, exact: true });
      assert.equal(await button.count(), 1);
      assert.equal(await button.isVisible(), true);
      assert.equal(await trigger(page).getAttribute("type"), "button");
      assert.equal(await trigger(page).getAttribute("aria-haspopup"), "dialog");
      const box = await rect(page, ".trigger");
      assert.ok(box.width >= 44 && box.height >= 44, JSON.stringify(box));
      return box;
    });

    await check(scope, "hostile host styles do not reach the component", async () => {
      const styles = await page.evaluate(() => {
        const root = document.querySelector("[data-home-screen-install]").shadowRoot;
        const button = getComputedStyle(root.querySelector(".trigger"));
        return {
          rootFontSize: getComputedStyle(document.documentElement).fontSize,
          display: button.display,
          fontSize: button.fontSize,
          textTransform: button.textTransform,
          letterSpacing: button.letterSpacing,
          closedDialogDisplay: getComputedStyle(root.querySelector("dialog")).display,
        };
      });
      assert.equal(styles.display, "inline-flex");
      assert.equal(styles.fontSize, styles.rootFontSize);
      assert.equal(styles.textTransform, "none");
      assert.equal(styles.letterSpacing, "normal");
      assert.equal(styles.closedDialogDisplay, "none");
      return styles;
    });

    await check(scope, "mouse click opens a native modal dialog with the guide; page still hears the click", async () => {
      const before = await uiState(page);
      await trigger(page).click();
      const state = await uiState(page);
      assert.equal(state.dialogOpen, true);
      assert.equal(state.modal, true);
      assert.equal(state.inner, "close", "focus moves into the dialog");
      assert.equal(state.clicks, before.clicks + 1, "click reached the page listener");
      const title = `Add ${demo.appName} to your Home Screen`;
      assert.equal(await page.getByRole("dialog", { name: title, exact: true }).count(), 1);
      const content = await page.evaluate(() => {
        const root = document.querySelector("[data-home-screen-install]").shadowRoot;
        const dialog = root.querySelector("dialog");
        return {
          steps: [...root.querySelectorAll(".steps li")].map((li) => li.textContent),
          note: root.querySelector(".note").textContent,
          animations: dialog.getAnimations ? dialog.getAnimations({ subtree: true }).length : 0,
        };
      });
      assert.equal(content.steps.length, 4);
      // The Share glyph is an aria-hidden SVG with no text, hence the double space.
      assert.equal(content.steps[0], "Tap Share  in Safari. If it isn’t visible, open Safari’s page menu first.");
      assert.match(content.steps[1], /Add to Home Screen/);
      assert.match(content.steps[2], /Open as Web App/);
      assert.ok(content.steps[3].includes(`open ${demo.appName} from your Home Screen`));
      assert.match(content.note, /Open this page in Safari/);
      assert.equal(content.animations, 0, "no animation");
      return content;
    });
    await screenshot(page, scope, "390x844-open");

    await check(scope, "Escape closes and focus returns to the visible trigger", async () => {
      await page.keyboard.press("Escape");
      await waitForInner(page, "trigger");
      const state = await uiState(page);
      assert.equal(state.dialogOpen, false);
      assert.equal(state.docActive, "host");
    });

    await check(scope, "Close button closes and focus returns to the trigger", async () => {
      const before = await uiState(page);
      await trigger(page).click();
      assert.equal((await uiState(page)).dialogOpen, true);
      await closeButton(page).click();
      await waitForInner(page, "trigger");
      const state = await uiState(page);
      assert.equal(state.dialogOpen, false);
      assert.equal(state.clicks, before.clicks + 2);
    });

    await check(scope, "keyboard: Enter and Space open, Escape and Enter on Close close", async () => {
      await trigger(page).focus();
      await page.keyboard.press("Enter");
      assert.equal((await uiState(page)).dialogOpen, true, "Enter opens");
      assert.equal((await uiState(page)).inner, "close");
      await page.keyboard.press("Escape");
      await waitForInner(page, "trigger");
      await page.keyboard.press("Space");
      assert.equal((await uiState(page)).dialogOpen, true, "Space opens");
      await page.keyboard.press("Enter");
      await waitForInner(page, "trigger");
      assert.equal((await uiState(page)).dialogOpen, false, "Enter on Close closes");
    });

    await check(scope, "API open()/close() are idempotent; focus never stays in the closed dialog", async () => {
      const out = await page.evaluate(() => {
        const root = document.querySelector("[data-home-screen-install]").shadowRoot;
        if (root.activeElement) root.activeElement.blur();
        const { instance } = window.__homeScreenInstallDemo;
        const first = instance.open();
        const second = instance.open();
        const open = root.querySelector("dialog").open;
        instance.close();
        instance.close();
        return { first, second, open, openAfter: root.querySelector("dialog").open };
      });
      assert.deepEqual(out, { first: true, second: true, open: true, openAfter: false });
      await waitForInner(page, "trigger");
    });

    await check(scope, "configured strings render as literal text (scripted second mount)", async () => {
      const out = await page.evaluate(() => {
        const { api } = window.__homeScreenInstallDemo;
        const box = document.createElement("div");
        document.body.append(box);
        const appName = '<img src=x onerror="window.__hsiTestXss=1"> & "Quotes"';
        const label = "<b>Install</b> me";
        const instance = api.mount(box, { appName, label });
        const host = box.firstElementChild;
        const root = host.shadowRoot;
        const result = {
          children: box.childElementCount,
          title: root.querySelector(".title").textContent,
          label: root.querySelector(".trigger").textContent,
          lastStep: root.querySelector(".steps li:last-child").textContent,
          markup: root.querySelectorAll("img, b").length,
        };
        instance.destroy();
        instance.destroy();
        result.childrenAfterDestroy = box.childElementCount;
        result.openAfterDestroy = instance.open();
        box.remove();
        result.xss = window.__hsiTestXss ?? null;
        return { appName, label, result };
      });
      assert.equal(out.result.children, 1);
      assert.equal(out.result.title, `Add ${out.appName} to your Home Screen`);
      assert.equal(out.result.label, out.label);
      assert.equal(out.result.lastStep, `Tap Add, then open ${out.appName} from your Home Screen.`);
      assert.equal(out.result.markup, 0);
      assert.equal(out.result.childrenAfterDestroy, 0);
      assert.equal(out.result.openAfterDestroy, false);
      assert.equal(out.result.xss, null);
    });

    await check(scope, "invalid mount input reports an error and inserts nothing", async () => {
      const out = await page.evaluate(() => {
        const { api } = window.__homeScreenInstallDemo;
        const box = document.createElement("div");
        const errors = [];
        for (const options of [{}, { appName: "  " }, { appName: "X", label: "" }]) {
          try {
            api.mount(box, options);
            errors.push(null);
          } catch (error) {
            errors.push(error.name);
          }
        }
        return { errors, children: box.childElementCount };
      });
      assert.deepEqual(out, { errors: ["TypeError", "TypeError", "TypeError"], children: 0 });
    });

    await check(scope, "destroy while open removes everything and leaves focus on the page", async () => {
      await trigger(page).click();
      assert.equal((await uiState(page)).dialogOpen, true);
      const out = await page.evaluate(() => {
        const { instance } = window.__homeScreenInstallDemo;
        instance.destroy();
        instance.destroy();
        return {
          hosts: document.querySelectorAll("[data-home-screen-install]").length,
          active: document.activeElement ? document.activeElement.tagName : null,
          openAfterDestroy: instance.open(),
        };
      });
      assert.deepEqual(out, { hosts: 0, active: "BODY", openAfterDestroy: false });
      await page.keyboard.press("Escape");
      await page.locator("h1").click({ timeout: 2000 });
      const state = await uiState(page);
      assert.equal(state.statusText, statusText(false), "status line remains");
    });

    await hygiene(scope, session, "browser mode");
  } finally {
    await session.context.close();
  }
}

async function touchSuite(browser, scope, demo) {
  const session = await openSession(browser, demo, { hasTouch: true });
  const { page } = session;
  try {
    await check(scope, "touch: tap opens, tap Close closes, focus returns to the trigger", async () => {
      await trigger(page).tap();
      assert.equal((await uiState(page)).dialogOpen, true);
      await closeButton(page).tap();
      await waitForInner(page, "trigger");
      assert.equal((await uiState(page)).dialogOpen, false);
    });
    await hygiene(scope, session, "touch");
  } finally {
    await session.context.close();
  }
}

const LAYOUTS = [
  { label: "320x568", width: 320, height: 568, rootPercent: 100 },
  { label: "320x568-200pct-text", width: 320, height: 568, rootPercent: 200 },
  { label: "568x320-landscape", width: 568, height: 320, rootPercent: 100 },
  { label: "568x320-landscape-200pct-text", width: 568, height: 320, rootPercent: 200 },
  { label: "844x390-landscape", width: 844, height: 390, rootPercent: 100 },
  { label: "1024x768-tablet", width: 1024, height: 768, rootPercent: 100 },
  { label: "1024x768-tablet-200pct-text", width: 1024, height: 768, rootPercent: 200 },
];

async function layoutSuite(browser, scope, demo) {
  const session = await openSession(browser, demo);
  const { page } = session;
  try {
    for (const layout of LAYOUTS) {
      await check(scope, `layout ${layout.label}: no horizontal overflow, targets >=44px, dialog fits and scrolls`, async () => {
        await page.setViewportSize({ width: layout.width, height: layout.height });
        await page.evaluate((percent) => {
          let style = document.getElementById("hsi-test-root-font");
          if (!style) {
            style = document.createElement("style");
            style.id = "hsi-test-root-font";
            document.head.append(style);
          }
          style.textContent = percent === 100 ? "" : `html { font-size: ${percent}% !important; }`;
        }, layout.rootPercent);

        return checkLayout(page, scope, layout);
      });
    }
    await hygiene(scope, session, "layouts");
  } finally {
    await session.context.close();
  }
}

// Root font-size set before any page script runs, so the component mounts
// with enlarged text from the start (the dynamic switch is covered above).
function enlargeRootFontAtLoad(percent) {
  const add = () => {
    const style = document.createElement("style");
    style.id = "hsi-test-root-font";
    style.textContent = `html { font-size: ${percent}% !important; }`;
    document.head.append(style);
  };
  if (document.head) {
    add();
    return;
  }
  const observer = new MutationObserver(() => {
    if (document.head) {
      observer.disconnect();
      add();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

async function layoutAtLoadSuite(browser, scope, demo) {
  const layout = { label: "320x568-200pct-text-at-load", width: 320, height: 568, rootPercent: 200 };
  const session = await openSession(browser, demo, {
    viewport: { width: layout.width, height: layout.height },
    rootPercentAtLoad: layout.rootPercent,
  });
  try {
    await check(scope, `layout ${layout.label}: enlarged from first render, dialog fits and scrolls`, () =>
      checkLayout(session.page, scope, layout)
    );
    await check(scope, `keyboard ${layout.label}: Tab reaches the guide; arrow, Page and End keys scroll it to the end`, () =>
      checkKeyboardScrolling(session.page, scope, demo, layout)
    );
    await hygiene(scope, session, "layout at load");
  } finally {
    await session.context.close();
  }
}

// Keyboard access to the scrolling guide using real key presses only. scrollTop
// is read, never set; this complements the geometry checks in checkLayout.
async function checkKeyboardScrolling(page, scope, demo, layout) {
  const metrics = () =>
    page.evaluate(() => {
      const root = document.querySelector("#install-slot > [data-home-screen-install]").shadowRoot;
      const body = root.querySelector(".body");
      const active = root.activeElement;
      return {
        dialogOpen: root.querySelector("dialog").open,
        scrollTop: body.scrollTop,
        maxScroll: body.scrollHeight - body.clientHeight,
        bodyBottom: body.getBoundingClientRect().bottom,
        lastBottom: root.querySelector(".note p:last-child").getBoundingClientRect().bottom,
        inner: active ? active.className : null,
        focusVisible: body.matches(":focus-visible"),
        outline: getComputedStyle(body).outlineStyle,
      };
    });
  const waitForScrollTop = (min, max) =>
    page.waitForFunction(
      ([low, high]) => {
        const body = document.querySelector("#install-slot > [data-home-screen-install]").shadowRoot.querySelector(".body");
        return body.scrollTop >= low && body.scrollTop <= high;
      },
      [min, max],
      { timeout: 3000 }
    );

  await trigger(page).click();
  let m = await metrics();
  assert.equal(m.dialogOpen, true);
  assert.equal(m.inner, "close", "Close has initial focus");
  assert.ok(m.maxScroll > 0, `precondition: the guide overflows at ${layout.label} (${JSON.stringify(m)})`);
  assert.equal(m.scrollTop, 0);

  await page.keyboard.press("Tab");
  await waitForInner(page, "body");
  m = await metrics();
  assert.equal(m.focusVisible, true, "guide region shows keyboard focus");
  assert.notEqual(m.outline, "none", "guide region has a visible focus outline");
  const title = `Add ${demo.appName} to your Home Screen`;
  assert.equal(await page.getByRole("region", { name: title, exact: true }).count(), 1, "named region");

  // A page-level listener (as a host app might have) records every key it
  // hears: the component must not stop key events, and must only claim the
  // scrolling keys it handles.
  await page.evaluate(() => {
    window.__hsiTestKeys = [];
    document.addEventListener("keydown", (event) => {
      window.__hsiTestKeys.push({ key: event.key, alt: event.altKey, prevented: event.defaultPrevented });
    });
  });

  const NO_LIMIT = Number.MAX_SAFE_INTEGER;
  const scrollTop = async () => (await metrics()).scrollTop;

  await page.keyboard.press("ArrowDown");
  await waitForScrollTop(1, NO_LIMIT);
  const afterArrow = await scrollTop();

  await page.keyboard.press("ArrowUp");
  await waitForScrollTop(0, afterArrow - 1);

  await page.keyboard.press("PageDown");
  await waitForScrollTop(afterArrow + 1, NO_LIMIT);
  const afterPageDown = await scrollTop();

  await page.keyboard.press("Space");
  await waitForScrollTop(afterPageDown + 1, NO_LIMIT);
  const afterSpace = await scrollTop();

  await page.keyboard.press("Shift+Space");
  await waitForScrollTop(0, afterSpace - 1);

  await page.keyboard.press("PageUp");
  await waitForScrollTop(0, afterPageDown - 1);

  await page.keyboard.press("End");
  await waitForScrollTop(m.maxScroll - 1, NO_LIMIT);
  m = await metrics();
  assert.ok(m.lastBottom <= m.bodyBottom + 0.5, "end of the guide is visible after End");
  await screenshot(page, scope, `${layout.label}-keyboard-end`);

  await page.keyboard.press("Home");
  await waitForScrollTop(0, 1);

  // Reverse and forward Tab between the region and Close, with no modified
  // keys pressed beforehand.
  await page.keyboard.press("Shift+Tab");
  await waitForInner(page, "close");
  const closeFocusVisible = await page.evaluate(() =>
    document.querySelector("#install-slot > [data-home-screen-install]").shadowRoot.querySelector(".close").matches(":focus-visible")
  );
  assert.equal(closeFocusVisible, true, "Close shows keyboard focus");
  await page.keyboard.press("Tab");
  await waitForInner(page, "body");

  // Forward Tab from the region must come back round to Close. Between the two,
  // focus may pass through the browser itself (document body) or the dialog
  // element, but never reaches inert page content.
  const cycle = [];
  for (let i = 0; i < 4 && cycle.at(-1)?.inner !== "close"; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(50);
    cycle.push(
      await page.evaluate(() => {
        const host = document.querySelector("#install-slot > [data-home-screen-install]");
        const active = host.shadowRoot.activeElement;
        return {
          outer: document.activeElement === host ? "host" : document.activeElement ? document.activeElement.tagName : null,
          inner: active ? active.className || active.tagName.toLowerCase() : null,
        };
      })
    );
  }
  assert.equal(cycle.at(-1)?.inner, "close", `forward Tab returns to Close ${JSON.stringify(cycle)}`);
  assert.ok(cycle.every((step) => step.outer === "host" || step.outer === "BODY"), `focus stays out of inert page content ${JSON.stringify(cycle)}`);
  await page.keyboard.press("Tab");
  await waitForInner(page, "body");

  const scrollKeys = await page.evaluate(() => window.__hsiTestKeys.filter((entry) => !["Shift", "Tab"].includes(entry.key)));
  assert.deepEqual(
    scrollKeys.map((entry) => entry.key),
    ["ArrowDown", "ArrowUp", "PageDown", " ", " ", "PageUp", "End", "Home"],
    "every scrolling key reached the page listener"
  );
  assert.ok(scrollKeys.every((entry) => entry.prevented), "handled scrolling keys are claimed");

  // A modified key is left to the browser and the page. What the browser then
  // does with it (WebKit itself scrolls the region on Option+Down) is recorded,
  // not asserted.
  await page.keyboard.press("Alt+ArrowDown");
  const altDown = await page.evaluate(() => window.__hsiTestKeys.find((entry) => entry.alt && entry.key === "ArrowDown"));
  assert.ok(altDown, "modified key reached the page listener");
  assert.equal(altDown.prevented, false, "modified key is not claimed by the component");
  const afterModifiedKey = await metrics();

  await page.keyboard.press("Escape");
  await waitForInner(page, "trigger");
  assert.equal((await metrics()).dialogOpen, false);
  return {
    maxScroll: m.maxScroll,
    afterArrow,
    afterPageDown,
    afterSpace,
    forwardTabCycle: cycle,
    afterModifiedKey: { inner: afterModifiedKey.inner, scrollTop: afterModifiedKey.scrollTop },
  };
}

// Shared by the dynamic and at-load layout checks. The root font-size is
// asserted first so a fixture problem is reported as such, not as a component
// failure; every size mismatch message includes all computed sizes.
async function checkLayout(page, scope, layout) {
  const expectedFont = 16 * (layout.rootPercent / 100);
  const closed = await page.evaluate(() => {
    const host = document.querySelector("[data-home-screen-install]");
    const root = host.shadowRoot;
    const r = root.querySelector(".trigger").getBoundingClientRect();
    const size = (node) => parseFloat(getComputedStyle(node).fontSize);
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      trigger: { left: r.left, right: r.right, width: r.width, height: r.height },
      fonts: {
        root: size(document.documentElement),
        pageHeading: size(document.querySelector("h1")),
        host: size(host),
        trigger: size(root.querySelector(".trigger")),
      },
    };
  });
  const fonts = JSON.stringify(closed.fonts);
  assert.equal(closed.fonts.root, expectedFont, `fixture: root font-size applied ${fonts}`);
  assert.equal(closed.fonts.host, expectedFont, `host font follows root font size ${fonts}`);
  assert.equal(closed.fonts.trigger, expectedFont, `button text follows root font size ${fonts}`);
  assert.ok(closed.scrollWidth <= closed.innerWidth, `page overflow ${closed.scrollWidth} > ${closed.innerWidth}`);
  assert.ok(closed.trigger.left >= 0 && closed.trigger.right <= closed.innerWidth + 0.5, "trigger inside viewport");
  assert.ok(closed.trigger.width >= 44 && closed.trigger.height >= 44, "trigger target size");
  await screenshot(page, scope, `${layout.label}-closed`);

  assert.equal(await page.evaluate(() => window.__homeScreenInstallDemo.instance.open()), true);
  const guideFonts = await page.evaluate(() => {
    const root = document.querySelector("[data-home-screen-install]").shadowRoot;
    const size = (selector) => parseFloat(getComputedStyle(root.querySelector(selector)).fontSize);
    return { dialog: size("dialog"), close: size(".close"), title: size(".title"), step: size(".steps li"), note: size(".note p") };
  });
  const guide = JSON.stringify(guideFonts);
  assert.equal(guideFonts.dialog, expectedFont, `guide text follows root font size ${guide}`);
  assert.equal(guideFonts.step, expectedFont, `guide steps follow root font size ${guide}`);
  assert.equal(guideFonts.close, expectedFont, `Close text follows root font size ${guide}`);
  assert.ok(Math.abs(guideFonts.title - expectedFont * 1.2) < 0.5, `title scales with the guide ${guide}`);
  assert.ok(Math.abs(guideFonts.note - expectedFont * 0.9375) < 0.5, `notes scale with the guide ${guide}`);

  const open = await page.evaluate(() => {
    const root = document.querySelector("[data-home-screen-install]").shadowRoot;
    const dialog = root.querySelector("dialog");
    const scroller = root.querySelector(".body");
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    scroller.scrollTop = 0;
    const top = {
      dialog: box(dialog),
      close: box(root.querySelector(".close")),
      title: box(root.querySelector(".title")),
      body: box(scroller),
    };
    scroller.scrollTop = scroller.scrollHeight;
    const bottom = {
      dialog: box(dialog),
      close: box(root.querySelector(".close")),
      body: box(scroller),
      last: box(root.querySelector(".note p:last-child")),
    };
    const result = {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dialogScrollWidth: dialog.scrollWidth,
      dialogClientWidth: dialog.clientWidth,
      bodyScrollWidth: scroller.scrollWidth,
      bodyClientWidth: scroller.clientWidth,
      scrollable: scroller.scrollHeight > scroller.clientHeight,
      pageScrollWidth: document.documentElement.scrollWidth,
      top,
      bottom,
    };
    scroller.scrollTop = 0;
    return result;
  });
  const d = open.top.dialog;
  assert.ok(d.left >= 0 && d.top >= 0 && d.right <= open.innerWidth + 0.5 && d.bottom <= open.innerHeight + 0.5, `dialog inside viewport ${JSON.stringify(d)}`);
  assert.ok(open.dialogScrollWidth <= open.dialogClientWidth, "no horizontal overflow inside the dialog");
  assert.ok(open.bodyScrollWidth <= open.bodyClientWidth, "guide text wraps without horizontal scrolling");
  assert.ok(open.pageScrollWidth <= open.innerWidth, "no page overflow while open");
  assert.ok(open.top.title.top >= open.top.body.top - 0.5, "title visible at the top of the guide");
  for (const where of ["top", "bottom"]) {
    const c = open[where].close;
    const dlg = open[where].dialog;
    assert.ok(c.width >= 44 && c.height >= 44, `${where}: Close target size`);
    assert.ok(c.top >= dlg.top - 0.5 && c.bottom <= dlg.bottom + 0.5, `${where}: Close visible while scrolled`);
    assert.ok(c.right <= dlg.right + 0.5 && c.left >= dlg.left - 0.5, `${where}: Close inside dialog`);
  }
  const body = open.bottom.body;
  assert.ok(body.height >= 0.4 * open.bottom.dialog.height, "guide area keeps most of the dialog");
  const last = open.bottom.last;
  assert.ok(last.bottom <= body.bottom + 0.5 && last.bottom > body.top, "end of guide reachable by scrolling");
  await screenshot(page, scope, `${layout.label}-open`);
  if (open.scrollable) {
    await page.evaluate(() => {
      const scroller = document.querySelector("[data-home-screen-install]").shadowRoot.querySelector(".body");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await screenshot(page, scope, `${layout.label}-open-scrolled`);
  }
  await page.keyboard.press("Escape");
  assert.equal((await uiState(page)).dialogOpen, false);
  return { scrollable: open.scrollable, dialog: d, fonts: closed.fonts, guideFonts };
}

async function injectedStartSuite(browser, scope, demo, signal) {
  const inject = signal === "navigator" ? { standalone: true, matches: false } : { standalone: false, matches: true };
  const session = await openSession(browser, demo, { inject });
  const { page } = session;
  try {
    await check(scope, `INJECTED: standalone at load via ${signal === "navigator" ? "navigator.standalone" : QUERY} hides the button from first insertion`, async () => {
      const observed = await page.evaluate(() => window.__hsiTestObserved);
      assert.deepEqual(observed, [{ hidden: true, display: "none" }], "hidden when inserted");
      const state = await uiState(page);
      assert.equal(state.statusText, statusText(true));
      assert.equal(state.statusMode, "home-screen");
      assert.equal(state.hidden, true);
      assert.equal(state.hostDisplay, "none", "hidden despite the page's [hidden] { display: block !important }");
      assert.equal(await page.getByRole("button", { name: LABEL }).count(), 0);
      const out = await page.evaluate(() => {
        const root = document.querySelector("[data-home-screen-install]").shadowRoot;
        root.querySelector(".trigger").focus();
        return {
          focused: root.activeElement ? root.activeElement.className : null,
          opened: window.__homeScreenInstallDemo.instance.open(),
          dialogOpen: root.querySelector("dialog").open,
        };
      });
      assert.deepEqual(out, { focused: null, opened: false, dialogOpen: false });
    });
    await screenshot(page, scope, `injected-standalone-${signal}`);
    await hygiene(scope, session, `injected ${signal}`);
  } finally {
    await session.context.close();
  }
}

async function injectedTransitionSuite(browser, scope, demo) {
  const session = await openSession(browser, demo, { inject: { standalone: false, matches: false } });
  const { page } = session;
  try {
    let baseline = 0;
    await check(scope, "INJECTED: display-mode change while open closes the dialog, hides the button and releases focus", async () => {
      baseline = await page.evaluate(() => window.__hsiTestInjected.listenerCount());
      assert.ok(baseline >= 2, "component and demo status both watch the media query");
      await trigger(page).click();
      assert.equal((await uiState(page)).inner, "close");
      await page.evaluate(() => window.__hsiTestInjected.setDisplayMode(true));
      const state = await uiState(page);
      assert.equal(state.dialogOpen, false);
      assert.equal(state.hidden, true);
      assert.equal(state.hostDisplay, "none");
      assert.equal(state.inner, null, "no focus inside hidden UI");
      assert.notEqual(state.docActive, "host");
      assert.equal(state.statusText, statusText(true));
      await page.waitForTimeout(50); // let the dialog's async close event run
      assert.equal((await uiState(page)).inner, null, "close handler does not refocus hidden UI");
    });

    await check(scope, "INJECTED: leaving standalone shows the button again without opening or stealing focus", async () => {
      await page.evaluate(() => window.__hsiTestInjected.setDisplayMode(false));
      const state = await uiState(page);
      assert.equal(state.hidden, false);
      assert.notEqual(state.hostDisplay, "none");
      assert.equal(state.dialogOpen, false);
      assert.equal(state.inner, null);
      assert.equal(state.statusText, statusText(false));
    });

    await check(scope, "INJECTED: navigator.standalone changes are picked up on pageshow and visibilitychange", async () => {
      await page.evaluate(() => {
        window.__hsiTestInjected.setNavigatorStandalone(true);
        const event = typeof PageTransitionEvent === "function" ? new PageTransitionEvent("pageshow", { persisted: true }) : new Event("pageshow");
        window.dispatchEvent(event);
      });
      let state = await uiState(page);
      assert.equal(state.hidden, true);
      assert.equal(state.statusMode, "home-screen");
      await page.evaluate(() => {
        window.__hsiTestInjected.setNavigatorStandalone(false);
        document.dispatchEvent(new Event("visibilitychange"));
      });
      state = await uiState(page);
      assert.equal(state.hidden, false);
      assert.equal(state.statusMode, "browser");
    });

    await check(scope, "INJECTED: destroy removes the component's media listener; later changes are harmless", async () => {
      await page.evaluate(() => window.__homeScreenInstallDemo.instance.destroy());
      assert.equal(await page.evaluate(() => window.__hsiTestInjected.listenerCount()), baseline - 1);
      await page.evaluate(() => window.__hsiTestInjected.setDisplayMode(true));
      const state = await uiState(page);
      assert.equal(state.hostCount, 0);
      assert.equal(state.statusText, statusText(true), "the demo's own watcher still reports the mode");
    });
    await hygiene(scope, session, "injected transitions");
  } finally {
    await session.context.close();
  }
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  evidenceDir = evidenceDirectory();
  const playwright = await loadPlaywright();
  const names = (process.env.HSI_BROWSERS || "chromium,webkit").split(",").map((name) => name.trim()).filter(Boolean);

  const server = createDemoServer();
  const launched = [];
  const engines = [];
  let interrupted = false;
  const cleanup = async () => {
    await Promise.allSettled(launched.map((browser) => browser.close()));
    await new Promise((done) => server.close(() => done()));
  };
  const onSignal = () => {
    interrupted = true;
    cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await new Promise((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", done);
    });
    const { port } = server.address();
    if (port === DEFAULT_PORT) throw new Error("test server must not use the native-demo port");
    origin = `http://127.0.0.1:${port}`;
    console.log(`Test server: ${origin} (non-native port)`);

    for (const name of names) {
      const type = playwright[name];
      if (!type || !["chromium", "webkit"].includes(name)) throw new Error(`Unsupported browser: ${name}`);
      const options = { headless: true };
      if (name === "chromium") {
        options.args = ["--mute-audio"];
        if (process.env.HSI_CHROMIUM_CHANNEL) options.channel = process.env.HSI_CHROMIUM_CHANNEL;
      }
      const browser = await type.launch(options);
      launched.push(browser);
      engines.push({ name, version: browser.version(), channel: options.channel ?? null, args: options.args ?? [] });

      for (const demo of DEMOS) {
        const scope = { browser: name, demo: demo.id };
        const suites = [
          ["browser mode", () => browserModeSuite(browser, scope, demo)],
          ["touch", () => touchSuite(browser, scope, demo)],
          ["layouts", () => layoutSuite(browser, scope, demo)],
          ["layout at load", () => layoutAtLoadSuite(browser, scope, demo)],
          ["INJECTED: navigator start", () => injectedStartSuite(browser, scope, demo, "navigator")],
          ["INJECTED: display-mode start", () => injectedStartSuite(browser, scope, demo, "display-mode")],
          ["INJECTED: transitions", () => injectedTransitionSuite(browser, scope, demo)],
        ];
        for (const [label, run] of suites) {
          // A failure outside a check (e.g. the page never became ready) is recorded, not swallowed.
          await check(scope, `${label} suite completed`, run);
        }
      }
      await browser.close();
      launched.splice(launched.indexOf(browser), 1);
    }
  } finally {
    if (!interrupted) await cleanup();
  }

  const failed = results.filter((entry) => entry.status === "fail");
  const report = {
    package: { name: pkg.name, version: pkg.version },
    finishedAt: new Date().toISOString(),
    server: "own ephemeral 127.0.0.1 port (not the native-demo port)",
    engines,
    note:
      "Automated Chromium/WebKit checks of the demos. Checks marked injected replace the standalone signals " +
      "inside the page and are not native Home Screen evidence.",
    totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length, injected: results.filter((entry) => entry.injected).length },
    results,
    screenshots,
  };
  writeFileSync(join(evidenceDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    `# Home Screen Install ${pkg.version} browser checks`,
    "",
    report.note,
    "",
    `Engines: ${engines.map((engine) => `${engine.name} ${engine.version}${engine.channel ? ` (${engine.channel})` : ""}`).join(", ")}`,
    `Totals: ${report.totals.passed}/${report.totals.checks} passed, ${report.totals.failed} failed, ${report.totals.injected} injected-branch checks.`,
    "",
    "| Result | Browser | Demo | Check |",
    "| --- | --- | --- | --- |",
    ...results.map((entry) => `| ${entry.status.toUpperCase()} | ${entry.browser} | ${entry.demo} | ${entry.name.replace(/\|/g, "\\|")} |`),
    "",
    `Screenshots (${screenshots.length}) are in screenshots/.`,
    "",
  ];
  writeFileSync(join(evidenceDir, "summary.md"), lines.join("\n"));
  console.log(`\n${report.totals.passed}/${report.totals.checks} passed; evidence in ${evidenceDir}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
