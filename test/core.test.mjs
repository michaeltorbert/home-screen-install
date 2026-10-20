// Detector, watcher and mount-validation tests with fake windows.
// Runs against the source, the generated ES module and the generated classic
// script (run `npm run build` first). Browser behavior is covered separately.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const QUERY = "(display-mode: standalone)";
const root = new URL("../", import.meta.url);
const distEsm = new URL("dist/home-screen-install.mjs", root);
const distClassic = new URL("dist/home-screen-install.js", root);

for (const file of [distEsm, distClassic]) {
  if (!existsSync(file)) throw new Error(`${fileURLToPath(file)} is missing; run npm run build first`);
}

function loadClassic() {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(distClassic, "utf8"), context, { filename: fileURLToPath(distClassic) });
  return context.HomeScreenInstall;
}

const implementations = [
  ["source", await import(new URL("src/home-screen-install.js", root))],
  ["dist ESM", await import(distEsm)],
  ["dist classic", loadClassic()],
];

function createTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type });
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

// A fake window whose two standalone signals can be changed independently.
function createEnv({ standalone, matches = false, legacy = false } = {}) {
  const state = { standalone, matches };
  const mqlEvents = createTarget();
  const mql = {
    media: QUERY,
    get matches() {
      return state.matches;
    },
  };
  if (legacy) {
    mql.addListener = (fn) => mqlEvents.addEventListener("change", fn);
    mql.removeListener = (fn) => mqlEvents.removeEventListener("change", fn);
  } else {
    mql.addEventListener = (type, fn) => mqlEvents.addEventListener(type, fn);
    mql.removeEventListener = (type, fn) => mqlEvents.removeEventListener(type, fn);
  }
  const queries = [];
  const doc = createTarget();
  const win = createTarget();
  win.document = doc;
  win.navigator = {
    get standalone() {
      return state.standalone;
    },
  };
  win.matchMedia = (query) => {
    queries.push(query);
    return mql;
  };
  return { win, doc, mqlEvents, state, queries };
}

function throwingGetter(object, name) {
  Object.defineProperty(object, name, {
    configurable: true,
    get() {
      throw new Error(`${name} blocked`);
    },
  });
  return object;
}

for (const [label, api] of implementations) {
  describe(`${label}: isStandaloneDisplay`, () => {
    test("exposes the public functions", () => {
      for (const name of ["isStandaloneDisplay", "watchDisplayMode", "mount"]) {
        assert.equal(typeof api[name], "function", name);
      }
      assert.equal(typeof api.VERSION, "string");
    });

    test("is false without a window (SSR) and for null or empty windows", () => {
      assert.equal(typeof globalThis.window, "undefined");
      assert.equal(api.isStandaloneDisplay(), false);
      assert.equal(api.isStandaloneDisplay(null), false);
      assert.equal(api.isStandaloneDisplay({}), false);
    });

    test("is true for navigator.standalone === true alone", () => {
      assert.equal(api.isStandaloneDisplay({ navigator: { standalone: true } }), true);
      assert.equal(api.isStandaloneDisplay(createEnv({ standalone: true }).win), true);
    });

    test("is true for display-mode standalone alone and queries the exact media string", () => {
      const env = createEnv({ standalone: false, matches: true });
      assert.equal(api.isStandaloneDisplay(env.win), true);
      assert.deepEqual(env.queries, [QUERY]);
      assert.equal(api.isStandaloneDisplay(createEnv({ matches: true }).win), true);
    });

    test("is false when both signals are false or absent", () => {
      assert.equal(api.isStandaloneDisplay(createEnv({ standalone: false }).win), false);
      assert.equal(api.isStandaloneDisplay(createEnv().win), false);
      assert.equal(api.isStandaloneDisplay({ navigator: {} }), false);
    });

    test("accepts only boolean true from each signal", () => {
      for (const value of ["true", "false", 1, {}, "standalone"]) {
        assert.equal(api.isStandaloneDisplay({ navigator: { standalone: value } }), false, `standalone=${String(value)}`);
        assert.equal(api.isStandaloneDisplay({ matchMedia: () => ({ matches: value }) }), false, `matches=${String(value)}`);
      }
    });

    test("a throwing navigator does not discard a true display-mode", () => {
      const env = createEnv({ matches: true });
      throwingGetter(env.win, "navigator");
      assert.equal(api.isStandaloneDisplay(env.win), true);
      assert.equal(api.isStandaloneDisplay(throwingGetter({ matchMedia: () => ({ matches: true }) }, "navigator")), true);
      const blockedFlag = throwingGetter({}, "standalone");
      assert.equal(api.isStandaloneDisplay({ navigator: blockedFlag, matchMedia: () => ({ matches: true }) }), true);
    });

    test("a throwing or missing matchMedia does not discard a true navigator.standalone", () => {
      const nav = { standalone: true };
      assert.equal(api.isStandaloneDisplay({ navigator: nav }), true);
      assert.equal(
        api.isStandaloneDisplay({
          navigator: nav,
          matchMedia() {
            throw new Error("matchMedia blocked");
          },
        }),
        true
      );
      assert.equal(api.isStandaloneDisplay({ navigator: nav, matchMedia: () => null }), true);
      assert.equal(api.isStandaloneDisplay({ navigator: nav, matchMedia: () => throwingGetter({}, "matches") }), true);
      assert.equal(api.isStandaloneDisplay(throwingGetter({ navigator: nav }, "matchMedia")), true);
    });

    test("both signals failing is false, not an error", () => {
      const win = throwingGetter(throwingGetter({}, "navigator"), "matchMedia");
      assert.equal(api.isStandaloneDisplay(win), false);
    });
  });

  describe(`${label}: watchDisplayMode`, () => {
    test("requires a function callback", () => {
      assert.throws(() => api.watchDisplayMode(null, createEnv().win), { name: "TypeError" });
      assert.throws(() => api.watchDisplayMode("callback", createEnv().win), { name: "TypeError" });
    });

    test("is an inert no-op without a window", () => {
      const calls = [];
      const stop = api.watchDisplayMode((value) => calls.push(value));
      assert.equal(typeof stop, "function");
      stop();
      stop();
      const stopNull = api.watchDisplayMode((value) => calls.push(value), null);
      stopNull();
      assert.deepEqual(calls, []);
    });

    test("does not call back initially and reports only changed values", () => {
      const env = createEnv({ standalone: false });
      const calls = [];
      const stop = api.watchDisplayMode((value) => calls.push(value), env.win);
      assert.deepEqual(calls, []);

      env.mqlEvents.dispatch("change");
      env.win.dispatch("pageshow");
      env.doc.dispatch("visibilitychange");
      assert.deepEqual(calls, [], "events without a mode change are ignored");

      env.state.matches = true;
      env.mqlEvents.dispatch("change");
      assert.deepEqual(calls, [true]);

      env.mqlEvents.dispatch("change");
      env.win.dispatch("pageshow");
      assert.deepEqual(calls, [true], "repeat events with the same mode are ignored");

      env.state.matches = false;
      env.win.dispatch("pageshow");
      assert.deepEqual(calls, [true, false]);

      env.state.standalone = true;
      env.doc.dispatch("visibilitychange");
      assert.deepEqual(calls, [true, false, true]);
      stop();
    });

    test("starts from a standalone window and reports leaving it", () => {
      const env = createEnv({ standalone: true });
      const calls = [];
      const stop = api.watchDisplayMode((value) => calls.push(value), env.win);
      env.win.dispatch("pageshow");
      assert.deepEqual(calls, []);
      env.state.standalone = false;
      env.win.dispatch("pageshow");
      assert.deepEqual(calls, [false]);
      stop();
    });

    test("listens to media change, pageshow and visibilitychange, and removes all on unsubscribe", () => {
      const env = createEnv();
      const calls = [];
      const stop = api.watchDisplayMode((value) => calls.push(value), env.win);
      assert.equal(env.mqlEvents.count("change"), 1);
      assert.equal(env.win.count("pageshow"), 1);
      assert.equal(env.doc.count("visibilitychange"), 1);

      stop();
      assert.equal(env.mqlEvents.count("change"), 0);
      assert.equal(env.win.count("pageshow"), 0);
      assert.equal(env.doc.count("visibilitychange"), 0);

      stop();
      env.state.matches = true;
      env.mqlEvents.dispatch("change");
      env.win.dispatch("pageshow");
      env.doc.dispatch("visibilitychange");
      assert.deepEqual(calls, [], "no callbacks after unsubscribe");
    });

    test("an unsubscribed listener that still fires does not call back", () => {
      const env = createEnv();
      const calls = [];
      let captured = null;
      const original = env.win.addEventListener;
      env.win.addEventListener = (type, fn) => {
        if (type === "pageshow") captured = fn;
        original(type, fn);
      };
      const stop = api.watchDisplayMode((value) => calls.push(value), env.win);
      stop();
      env.state.standalone = true;
      captured({ type: "pageshow" });
      assert.deepEqual(calls, []);
    });

    test("falls back to legacy MediaQueryList addListener/removeListener", () => {
      const env = createEnv({ legacy: true });
      const calls = [];
      const stop = api.watchDisplayMode((value) => calls.push(value), env.win);
      assert.equal(env.mqlEvents.count("change"), 1);
      env.state.matches = true;
      env.mqlEvents.dispatch("change");
      assert.deepEqual(calls, [true]);
      stop();
      stop();
      assert.equal(env.mqlEvents.count("change"), 0);
      assert.equal(env.win.count("pageshow"), 0);
      assert.equal(env.doc.count("visibilitychange"), 0);
    });

    test("keeps pageshow and visibilitychange when matchMedia throws", () => {
      const env = createEnv();
      env.win.matchMedia = () => {
        throw new Error("matchMedia blocked");
      };
      const calls = [];
      const stop = api.watchDisplayMode((value) => calls.push(value), env.win);
      env.state.standalone = true;
      env.win.dispatch("pageshow");
      env.state.standalone = false;
      env.doc.dispatch("visibilitychange");
      assert.deepEqual(calls, [true, false]);
      stop();
      assert.equal(env.win.count("pageshow"), 0);
      assert.equal(env.doc.count("visibilitychange"), 0);
    });

    test("keeps the other listeners when media listener registration throws", () => {
      const env = createEnv();
      const mql = env.win.matchMedia(QUERY);
      mql.addEventListener = () => {
        throw new Error("no listeners");
      };
      const calls = [];
      const stop = api.watchDisplayMode((value) => calls.push(value), env.win);
      env.state.matches = true;
      env.win.dispatch("pageshow");
      assert.deepEqual(calls, [true]);
      stop();
      assert.equal(env.win.count("pageshow"), 0);
    });

    test("keeps media and pageshow listeners when document is unavailable", () => {
      const env = createEnv();
      throwingGetter(env.win, "document");
      const calls = [];
      const stop = api.watchDisplayMode((value) => calls.push(value), env.win);
      env.state.matches = true;
      env.mqlEvents.dispatch("change");
      assert.deepEqual(calls, [true]);
      stop();
      assert.equal(env.mqlEvents.count("change"), 0);
      assert.equal(env.win.count("pageshow"), 0);
    });
  });

  describe(`${label}: mount validation`, () => {
    // A container whose document records every DOM call and refuses to build,
    // so these tests can see what mount touches before it fails.
    function fakeContainer({ defaultView } = {}) {
      const calls = [];
      const view =
        defaultView === undefined
          ? {
              get navigator() {
                calls.push("detect");
                return { standalone: false };
              },
              matchMedia() {
                calls.push("detect");
                return { matches: false };
              },
            }
          : defaultView;
      const ownerDocument = {
        defaultView: view,
        createElement(tag) {
          calls.push(`create:${tag}`);
          throw new Error("fake document cannot build elements");
        },
      };
      const element = {
        nodeType: 1,
        ownerDocument,
        appendChild() {
          calls.push("insert");
        },
        append() {
          calls.push("insert");
        },
      };
      return { element, calls };
    }

    test("rejects a missing or non-element container", () => {
      for (const container of [undefined, null, {}, "#app", { nodeType: 3 }, { nodeType: 9 }]) {
        assert.throws(() => api.mount(container, { appName: "Demo" }), { name: "TypeError" });
      }
    });

    test("rejects a container without a window", () => {
      const { element, calls } = fakeContainer({ defaultView: null });
      assert.throws(() => api.mount(element, { appName: "Demo" }), { name: "TypeError" });
      assert.throws(() => api.mount({ nodeType: 1, ownerDocument: null }, { appName: "Demo" }), { name: "TypeError" });
      assert.deepEqual(calls, []);
    });

    test("rejects a missing or blank appName before touching the DOM", () => {
      const { element, calls } = fakeContainer();
      for (const options of [undefined, null, {}, { appName: "" }, { appName: "   " }, { appName: 42 }, "Demo"]) {
        assert.throws(() => api.mount(element, options), { name: "TypeError" });
      }
      assert.deepEqual(calls, []);
    });

    test("rejects an invalid label or nonce before touching the DOM", () => {
      const { element, calls } = fakeContainer();
      for (const extra of [{ label: "" }, { label: "  " }, { label: 7 }, { label: null }, { nonce: 5 }, { nonce: null }]) {
        assert.throws(() => api.mount(element, { appName: "Demo", ...extra }), { name: "TypeError" });
      }
      assert.deepEqual(calls, []);
    });

    test("decides the display mode before creating or inserting any UI", () => {
      const { element, calls } = fakeContainer();
      assert.throws(() => api.mount(element, { appName: "Demo", label: "Install", nonce: "abc" }), {
        message: "fake document cannot build elements",
      });
      const firstCreate = calls.findIndex((call) => call.startsWith("create:"));
      assert.ok(calls.indexOf("detect") !== -1 && calls.indexOf("detect") < firstCreate, calls.join(" "));
      assert.equal(calls[firstCreate], "create:div");
      assert.ok(!calls.includes("insert"));
    });
  });
}
