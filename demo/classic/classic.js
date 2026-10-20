// Classic-script demo: uses the HomeScreenInstall global from
// ../../dist/home-screen-install.js, the way a no-build app would.
(function () {
  "use strict";

  var status = document.getElementById("status");
  var heard = document.getElementById("clicks-heard");
  var clicks = 0;

  // Click sentinel: the component must not stop clicks reaching the page.
  document.addEventListener("click", function () {
    clicks += 1;
    heard.textContent = String(clicks);
  });

  function showError(message) {
    status.setAttribute("data-state", "error");
    status.removeAttribute("data-mode");
    status.textContent = "Could not start Home Screen Install: " + message;
  }

  var api = window.HomeScreenInstall;
  if (!api) {
    showError("dist/home-screen-install.js did not load. Run npm run build.");
    return;
  }

  var instance;
  try {
    instance = api.mount(document.getElementById("install-slot"), { appName: "HSI Classic" });
  } catch (error) {
    showError(error && error.message ? error.message : String(error));
    return;
  }

  // Shown only after mount succeeded; the mode comes from the shipped detector.
  function render(standalone) {
    status.setAttribute("data-state", "ready");
    status.setAttribute("data-mode", standalone ? "home-screen" : "browser");
    status.textContent = "Version " + api.VERSION + " · Mode: " + (standalone ? "Home Screen" : "Browser");
  }
  render(api.isStandaloneDisplay());
  api.watchDisplayMode(render);

  // Demo/test hook only. Not part of the component API.
  window.__homeScreenInstallDemo = { api: api, instance: instance };
})();
