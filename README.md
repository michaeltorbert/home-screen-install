# Home Screen Install

A small, framework-independent “Add to Home Screen” button for browser apps.

- The button shows whenever the current window is **not** running as a Home Screen web app, and hides when it is.
- Pressing it opens a short guide in a native modal dialog: Safari’s Share menu → **Add to Home Screen** → keep **Open as Web App** on → **Add**.
- It cannot install anything itself. iPhone and iPad have no programmatic install prompt, and the component does not use `beforeinstallprompt`.

Version 0.1.0. No runtime dependencies. The source is public at [michaeltorbert/home-screen-install](https://github.com/michaeltorbert/home-screen-install), and versions are delivered as GitHub releases. The package is marked private and is not published to npm or any other registry, CDN or hosted location.

## What “standalone” means here

The decision uses the **current display mode** only:

```
navigator.standalone === true  OR  matchMedia("(display-mode: standalone)").matches
```

This is not an “installed” flag. A person who added the app to their Home Screen and then opens it in a normal Safari tab sees the button in that tab, which is intended. The component never stores anything, and it ignores user-agent strings, the referrer, generic fullscreen and storage flags.

Use `display: "standalone"` in your web app manifest. Pages opened as `minimal-ui` or `fullscreen` apps outside iOS do not match the standalone query and will show the button.

## Files

| File | Use |
| --- | --- |
| `dist/home-screen-install.js` | Classic script. Defines the global `HomeScreenInstall`. |
| `dist/home-screen-install.mjs` | ES module with named exports. Safe to import during server-side rendering. |
| `dist/SHA256SUMS` | SHA-256 checksums of the two files above. |

Both files are generated from `src/home-screen-install.js`. Edit the source and rebuild; never edit `dist/` by hand.

## Quick start

Classic script (no build step):

```html
<div id="home-screen-install"></div>
<script src="vendor/home-screen-install/home-screen-install.js"></script>
<script src="app-install-button.js"></script>
```

```js
// app-install-button.js
HomeScreenInstall.mount(document.getElementById("home-screen-install"), { appName: "My App" });
```

ES module:

```js
import { mount } from "./vendor/home-screen-install/home-screen-install.mjs";

const installButton = mount(document.querySelector("#home-screen-install"), { appName: "My App" });
// Later, if the view is torn down:
installButton.destroy();
```

See [ADOPTING.md](ADOPTING.md) for per-app notes, React and SSR examples.

## API

### `VERSION`

The package version string, injected by the build (for example `"0.1.0"`).

### `isStandaloneDisplay(win?) → boolean`

`true` when `win` (default: the global `window`) is currently displayed as a standalone web app. Each signal is read separately inside its own `try`, so a failure in one cannot hide a valid answer from the other. Only the boolean `true` counts. Returns `false` when there is no window, for example during SSR.

### `watchDisplayMode(callback, win?) → unsubscribe`

Calls `callback(isStandalone)` when the display mode changes. It listens for the media query `change` event (falling back to `addListener` on older Safari), the window `pageshow` event and the document `visibilitychange` event. Each event triggers a re-check, and the callback runs only when the value actually changes.

There is no initial call; read `isStandaloneDisplay()` for the starting value. `unsubscribe()` removes every listener and is safe to call more than once. Without a window it returns a no-op `unsubscribe`.

### `mount(container, options) → { open, close, destroy }`

Appends one `<div data-home-screen-install>` to `container`. It is a plain element, not a custom element, and has an open shadow root containing the button and the guide dialog.

| Option | Required | Meaning |
| --- | --- | --- |
| `appName` | yes | Name used in the guide (“Add *appName* to your Home Screen”). Inserted as plain text. |
| `label` | no | Button text. Default `"Add to Home Screen"`. Inserted as plain text. |
| `nonce` | no | CSP nonce for the component’s single `<style>` element. See [CSP](#content-security-policy). |

- **Input checks.** Throws a `TypeError` when `container` is not an element in a document with a window, or when `appName`, `label` or `nonce` is invalid. These checks happen before anything is inserted.
- **No flash.** The display mode is decided before insertion, so in standalone mode the button is hidden from the first frame.
- **`open()`.** Shows the guide and returns `true`. It returns `false` and does nothing after `destroy()`, in standalone mode, while the host is disconnected or not rendered, or when `<dialog>.showModal` is unavailable.
- **`close()`.** Closes the guide. Safe to call any time.
- **`destroy()`.** Closes the guide, moves focus off the component if it was there, removes its listeners and the host element. Safe to call more than once.

The component reads the mode from `container.ownerDocument.defaultView`.

## Behavior

- **Mode changes.** When the window switches to standalone mode, an open guide closes, the button hides and focus leaves the hidden UI. When it switches back, the button reappears without opening anything or moving focus.
- **Dialog.** The guide is a native `<dialog>` opened with `showModal()`, so the browser handles modality, page inertness and Escape. A Close button sits in a bar that stays in place while the guide text scrolls, which keeps it reachable with enlarged text on small screens. Close gets focus when the guide opens. The guide text is a named region that Tab reaches next. Close has an explicit `tabindex="0"` because, with default settings, WebKit leaves buttons out of the Tab order, which would otherwise leave Close reachable only by pointer. The page button itself follows the page’s normal Tab conventions, like the app’s other buttons. While it has focus, it scrolls itself on ↑/↓, Page Up/Down, Space/Shift+Space, Home and End, because WebKit neither makes the area focusable on its own nor scrolls it from the keyboard. It handles only those keys, only without Alt, Ctrl or Cmd, and only when there is something to scroll. It never stops key events from reaching the page. The guide always opens at the first step.
- **Focus.** When the guide closes, the browser first restores focus to wherever it was. If that leaves focus nowhere useful (Safari does not focus a button on click), focus returns to the visible button.
- **Host page.** Nothing is added outside the container. The component does not stop events from reaching the page, add global styles, use storage or cookies, make network requests, play audio, send telemetry, load fonts or external assets, or read app state.

## Guide text

1. Tap **Share** in Safari. If it isn’t visible, open Safari’s page menu first.
2. Choose **Add to Home Screen**. If you don’t see it, scroll down or expand the list.
3. If **Open as Web App** is shown, leave it turned on.
4. Tap **Add**, then open *appName* from your Home Screen.

Notes below the steps:

- Inside another app and can’t find Share? Open this page in Safari first.
- Other browsers may offer Install or Add to Home Screen in their menu.
- Already added? Open *appName* from its Home Screen icon.

The wording is fixed in 0.1.0 because Safari’s layout varies by device and settings. The guide names the controls instead of trying to detect the browser.

## Styling

The app chooses where the button goes (`container`) and can theme it with these inherited custom properties, set on the container or any ancestor:

| Property | Default | Used for |
| --- | --- | --- |
| `--hsi-accent` | `#1f5fbf` | Button background, focus ring |
| `--hsi-on-accent` | `#ffffff` | Button text |
| `--hsi-surface` | `#ffffff` | Dialog background |
| `--hsi-text` | `#1d2329` | Dialog text |
| `--hsi-font` | system UI font stack | Button and dialog font family |
| `--hsi-font-size` | `1rem` | Button and dialog base size; follows the root font size, including later changes |
| `--hsi-radius` | `12px` | Button corner radius (dialog uses radius + 4px) |

The button also has `part="button"`, so `[data-home-screen-install]::part(button) { … }` can adjust it further. Keep the 44 px minimum target size if you do.

The host is `display: inline-block` by default and can be laid out like any element. Page rules such as `button { … }`, `dialog { … }` or `[hidden] { display: block !important }` do not reach the shadow content, and the internal hidden rule wins over them. Inherited text properties such as `text-transform` and `letter-spacing` are reset on the button and dialog. Other inherited properties, and anything an app sets through the custom properties or `::part`, are the app’s choice.

The app is responsible for checking contrast between its chosen colors.

## Content Security Policy

The component adds one `<style>` element inside its shadow root and no inline scripts, and it builds its DOM without `innerHTML`.

It also sets one inline property on its own host element, `font-size: var(--hsi-font-size, 1rem)`. This keeps the button and guide text following root font-size changes in WebKit, which can leave `rem` values inside a shadow tree stale. The property is set through CSSOM (`element.style.setProperty`), which `style-src-attr` does not block. Size the component with `--hsi-font-size` rather than a `font-size` rule on the host.

- If the page has a CSP without `'unsafe-inline'` in `style-src`, pass the page’s per-response nonce as `nonce`. Static sites without a server-generated nonce need `'unsafe-inline'` for styles, or must leave styles unrestricted.
- The classic script is an ordinary same-origin file (`script-src 'self'`). Mount it from a file rather than an inline `<script>` if inline scripts are blocked.

Each app needs its own CSP check before adoption. This package does not configure CSP.

## Requirements and limits

- **Browser support.** Needs Shadow DOM and `HTMLDialogElement.showModal` (Safari/iOS 15.4+ and current Chromium, Firefox and Edge). Without `showModal`, `open()` returns `false`.
- **Current mode only.** The button tells you nothing about whether the app is installed elsewhere.
- **In-app browsers.** Pages opened inside other apps are treated as browser mode. The guide tells people to open the page in Safari when Share is missing.
- **Manifest and icons.** The button guides only. Whether a launched icon opens as a standalone web app depends on the page’s manifest, icons and the user’s **Open as Web App** choice.
- **Translations.** Text is English only in 0.1.0, apart from `label` and `appName`.

## Vendoring and updates

Each app keeps its own committed copy, and pages load only that local file. There is no CDN, remote loader or runtime “latest” lookup.

- **Releases.** Each version is a GitHub release `vX.Y.Z` with `home-screen-install.js`, `home-screen-install.mjs`, `SHA256SUMS` and `release-manifest.json` (version, tag, full commit, asset hashes, implementing author). The release is created from the exact tagged commit and checked after upload; see [automation/README.md](automation/README.md#release).
- **Consumers.** Four repositories, covering six apps, each vendor one format with the release’s `SHA256SUMS` and a `home-screen-install.lock.json` pin. A small offline check, `npm run check:home-screen-install`, runs on their pull requests.
- **Updates.** A local daily job on one Mac proposes newer stable releases to those repositories as ordinary pull requests, through the existing GitHub App. It never merges or deploys. It runs only while that Mac is on and logged in. See [automation/README.md](automation/README.md).

To update a copy by hand instead, copy the file you use and `SHA256SUMS` from the release (or `dist/`) and verify it from that directory:

```sh
grep ' home-screen-install.js$' SHA256SUMS | shasum -a 256 -c -    # classic
grep ' home-screen-install.mjs$' SHA256SUMS | shasum -a 256 -c -   # ES module
```

To make a new version:

1. Bump `version` in `package.json` and add a `## x.y.z` section to `CHANGELOG.md`.
2. Run `npm run build` and `npm test`, plus `npm run test:browser` and the native checks when the UI changed.
3. Publish it with `scripts/release.mjs`.

After adopting or updating, confirm the version in the app (for example `HomeScreenInstall.VERSION` in the console), run the app’s own tests and check its page in a browser. This package’s tests do not certify an app’s integration.

## Development

```sh
npm run build          # generate dist/ and the demo icons (writes only changed files)
npm run check:dist     # verify generated files match the source; writes nothing
npm test               # Node tests: detector, watcher, mount input checks, dist parity, demos, server, distribution tooling
npm run demo           # serve the demos at http://localhost:8796/
```

The distribution tests need `git` and loopback networking; they simulate GitHub with local repositories and a local server.

The source layout:

```
src/home-screen-install.js     canonical source (single export block at the end)
scripts/build.mjs              dependency-free build (also draws the demo icons)
dist/                          generated scripts + SHA256SUMS
demo/                          classic and ES module demos, shared CSS, serve.mjs
test/*.test.mjs                node:test suites
test/browser/run.mjs           Chromium/WebKit harness using the Playwright library
test/browser/probe-root-font.mjs   diagnostic: shadow-tree font sizes after a root font-size change
test/browser/probe-reverse-tab.mjs diagnostic: focus inside the open guide for fixed key sequences
distribution/                  consumer map and the consumer checker/workflow templates
scripts/*.mjs, scripts/lib/    stage, release, updater and runner-install commands
automation/                    operator guide and launchd template
```

### Browser checks

```sh
HSI_EVIDENCE_DIR=/absolute/path/outside/this/package \
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright \
node test/browser/run.mjs
```

- **Playwright location.** `PLAYWRIGHT_MODULE` is optional when `playwright` or `playwright-core` can be imported normally. The harness uses the Playwright library directly; it does not need `@playwright/test`.
- **Options.** `HSI_CHROMIUM_CHANNEL=chrome` uses installed Chrome, and `HSI_BROWSERS=chromium` or `webkit` limits the engines.
- **Server.** The harness starts its own server on a random local port (never 8796) and closes everything it launched.
- **Output.** It writes `results.json`, `summary.md` and screenshots to `HSI_EVIDENCE_DIR`, which must be outside the package.
- **Audio.** Chromium runs with `--mute-audio`, and the checks assert the pages contain no media elements.
- **Injected checks.** Checks named `INJECTED:` replace the standalone signals inside the page. They test the standalone code path but are **not** evidence of real Home Screen behavior.

### Native Home Screen check (manual)

1. Run `npm run build`, then `npm run demo`. Keep port 8796, because an installed icon remembers the exact origin.
2. In Safari on an iPhone or iPad simulator, open `http://localhost:8796/demo/classic/`. A physical device needs `--host` with a LAN address and that address in the URL.
3. Check the status line reads `Version 0.1.0 · Mode: Browser` and the button is visible.
4. Open the guide and follow it: Share → Add to Home Screen → leave Open as Web App on → Add.
5. Launch the **HSI Classic** icon. The status line should read `Mode: Home Screen` and the button should be absent.
6. Repeat with `http://localhost:8796/demo/esm/` and the **HSI ESM** icon.
7. Also try larger Safari text sizes with the guide open.

Each demo has its own manifest `id`, `start_url`, `scope`, name and icon, so both can be installed side by side.

## License

No license has been chosen. The source is publicly visible, but no reuse rights are granted. The package is marked private so it cannot be published to npm by accident.
