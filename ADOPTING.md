# Adopting Home Screen Install

This guide is for the six apps whose adoption is tracked in their own open issues. None of them shows the button yet. Each app adopts it separately, under its own issue.

| App | Repository | Issue | Vendored copy | Integration style |
| --- | --- | --- | --- | --- |
| Football (`/football/`) | games | #193 | `shared/home-screen-install/home-screen-install.js` | Classic script |
| Place by Place (`/place-value-practice/`) | games | #194 | same file | Classic script |
| Kayak (`/kayak/`) | games | #195 | same file | Classic script |
| Math Connections | math-connections | #4 | `src/vendor/home-screen-install/home-screen-install.mjs` | ES module from a static page |
| Homecall | homecall | #52 | `src/vendor/home-screen-install/home-screen-install.mjs` | ES module (Vite) |
| Saturday Signal | sportsapp | #169 | `src/vendor/home-screen-install/home-screen-install.mjs` | React client effect (Vite/vinext, SSR) |

The vendored copies are delivered by setup and update pull requests in each repository (see [automation/README.md](automation/README.md)). A vendored copy is inert: nothing loads it until an app adopts it. Track these states separately per app:

- **vendored:** the setup PR is merged;
- **updates active:** the local updater is installed and has run;
- **UI adopted:** the app mounts the button;
- **native verified:** the app was checked on iPhone/iPad as its issue requires.

Keep each issue open until that app is adopted and natively verified. Reference issues from distribution PRs with `Refs`, never a closing keyword.

## Every app

1. **Use the vendored copy.** Load the file from the vendored directory above. Do not edit it; `npm run check:home-screen-install` verifies it against its lock and checksum.
2. **Placement.** Add a container where the button should appear, and choose the `appName` people will recognize on their Home Screen.
3. **Theme.** Theme with `--hsi-*` custom properties on the container or an ancestor if needed.
4. **CSP.** Check the app’s CSP: the component needs one `<style>` element (pass `nonce` or allow inline styles).
5. **Manifest.** Check that the manifest uses `"display": "standalone"` with a scope and start URL that cover the page. Check that an `apple-touch-icon` exists. Changing install identity is out of scope for this stage; note gaps in the app’s issue.
6. **Verify.** Test in the app: the button shows in a Safari tab, the guide opens and closes with Close and Escape, and focus returns to the button. After Add to Home Screen, the icon launch shows no button.
7. **State.** The component must not change app behavior, settings, game or learning state, subscriptions, alerts or audio. If anything changes, stop and investigate.

The component reports the **current display mode**, not whether the app is installed. Don’t use it to infer installation, and don’t persist its value.

## Classic script apps: Football (#193), Place by Place (#194), Kayak (#195)

The games repository uses plain globals and ordered `<script>` tags with no build step, and it has a `shared/` directory. Leave the existing scripts and their order unchanged. Add the component as two new tags after them.

Example for `/football/index.html`, using the vendored `shared/home-screen-install/` copy (the mount file name is illustrative):

```html
<div id="home-screen-install"></div>
…existing scripts, unchanged…
<script src="../shared/home-screen-install/home-screen-install.js"></script>
<script src="home-screen-install-mount.js"></script>
```

```js
// football/home-screen-install-mount.js
(function () {
  var container = document.getElementById("home-screen-install");
  if (container && window.HomeScreenInstall) {
    window.HomeScreenInstall.mount(container, { appName: "Football" });
  }
})();
```

Use `"Place by Place"` and `"Kayak"` for the other two. The one vendored copy in `shared/home-screen-install/` serves all three. Each app then has its own small mount file and container. Adoption is a game release: follow the games repository’s version, cache-key and registry rules for each adopted game.

The page lives as long as the app, so `destroy()` is not needed. If a game screen removes the container, call `destroy()` on the instance first.

## Static page: Math Connections (#4)

A static `index.html` app with no build step, in `michaeltorbert/math-connections`. Import the vendored ES module:

```html
<div id="home-screen-install"></div>
<script type="module">
  // Or put this in a src/ module file if inline scripts are restricted.
  import { mount } from "./src/vendor/home-screen-install/home-screen-install.mjs";
  mount(document.getElementById("home-screen-install"), { appName: "Math Connections" });
</script>
```

Follow the repository’s `scripts/git-safety-check.sh` and pre-push checks when adopting.

## ES module app: Homecall (#52)

Homecall is a Vite app with Node built-in tests and jsdom. The ES module is vendored at `src/vendor/home-screen-install/`, outside `public/`, so Vite bundles it only once client code imports it. Mount it from client code once the container exists:

```js
import { mount } from "./vendor/home-screen-install/home-screen-install.mjs";

const installButton = mount(document.querySelector("#home-screen-install"), { appName: "Homecall" });
// If the view that owns the container is torn down:
// installButton.destroy();
```

- **Separate from audio and sessions.** Keep it apart from audio, recording, manual-sync and session code. The component has no audio and does not read app state.
- **jsdom tests.**
  - jsdom has no `matchMedia`, so `isStandaloneDisplay()` returns `false` there (browser mode).
  - jsdom does no layout, so `open()` returns `false` because the button is not rendered.
  - Mounting, the button's presence and `destroy()` cleanup can still be tested.
  - Don’t treat jsdom as dialog or focus evidence.

## React with SSR: Saturday Signal (#169)

Saturday Signal uses React 19, Vite/vinext and server rendering. The ES module is vendored at `src/vendor/home-screen-install/` and touches no browser globals when imported, so it can be imported from server-rendered modules. Mount it only in a client effect (adjust the relative import to the component’s location):

```jsx
import { useEffect, useRef } from "react";
import { mount } from "../src/vendor/home-screen-install/home-screen-install.mjs";

export function HomeScreenInstallButton() {
  const containerRef = useRef(null);

  useEffect(() => {
    const installButton = mount(containerRef.current, { appName: "Saturday Signal" });
    return () => installButton.destroy();
  }, []);

  // React renders an empty container; the component owns its single child.
  return <div ref={containerRef} />;
}
```

- **Strict Mode.** In development, React runs effects twice (mount → destroy → mount). Since `destroy()` removes the host, exactly one button remains.
- **Server render.** The server HTML contains only the empty container. The button appears after hydration in browser mode, and stays hidden from first insertion in standalone mode.
- **Children.** Don’t render React children inside the container.
- **Out of scope.** No alert, service worker, origin or subscription changes belong in this adoption.

To show the mode elsewhere in the UI, subscribe in an effect and return the unsubscribe function:

```jsx
useEffect(() => watchDisplayMode(setStandalone), []);
// Read the initial value on the client: isStandaloneDisplay()
```

## Updating an app later

New releases arrive as pull requests titled “Update home-screen-install to vX.Y.Z”. They change only the three files in the vendor directory. Before merging one:

1. Read the release’s `CHANGELOG.md` section.
2. Let the repository’s checks finish on the PR head.
3. If the app has adopted the button, treat the merge as an app release: run the app’s own tests and the in-app checks above, and follow its version, cache and native-verification rules.

Shared-package tests do not certify an app’s integration.
