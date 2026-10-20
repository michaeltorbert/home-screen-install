# Changelog

## 0.1.0

First release. The runtime files are the approved local 0.1.0 deliverable, unchanged.

- `isStandaloneDisplay(win?)`: `navigator.standalone === true` OR `matchMedia("(display-mode: standalone)").matches`, each signal read independently.
- `watchDisplayMode(callback, win?)`: reports changes from the media query (with the legacy `addListener` fallback), `pageshow` and `visibilitychange`; no initial call; idempotent unsubscribe.
- `mount(container, { appName, label?, nonce? })`: one shadow-hosted Add to Home Screen button with a native modal guide dialog; hidden in standalone mode; `open()`, `close()`, `destroy()`.
- Generated `dist/home-screen-install.mjs` (ES module), `dist/home-screen-install.js` (classic script, global `HomeScreenInstall`) and `dist/SHA256SUMS`.
- Classic-script and ES module demos with separate manifests and generated icons; local demo server; Node tests and a Playwright-library browser harness.

Distribution, which ships no runtime code: GitHub release assets with a release manifest; a consumer map for four repositories covering six apps; an offline vendor checker; and stage, release, updater and launchd runner-install commands.
