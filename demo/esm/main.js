// ES module demo: uses ../../dist/home-screen-install.mjs. Apps normally use a
// static import; this demo imports dynamically only so a missing build is
// reported on the page instead of failing silently.

const status = document.getElementById("status");
const heard = document.getElementById("clicks-heard");
let clicks = 0;

// Click sentinel: the component must not stop clicks reaching the page.
document.addEventListener("click", () => {
  clicks += 1;
  heard.textContent = String(clicks);
});

function showError(message) {
  status.dataset.state = "error";
  delete status.dataset.mode;
  status.textContent = `Could not start Home Screen Install: ${message}`;
}

async function start() {
  let api;
  try {
    api = await import("../../dist/home-screen-install.mjs");
  } catch {
    showError("dist/home-screen-install.mjs did not load. Run npm run build.");
    return;
  }

  let instance;
  try {
    instance = api.mount(document.getElementById("install-slot"), { appName: "HSI ESM" });
  } catch (error) {
    showError(error?.message ?? String(error));
    return;
  }

  // Shown only after mount succeeded; the mode comes from the shipped detector.
  const render = (standalone) => {
    status.dataset.state = "ready";
    status.dataset.mode = standalone ? "home-screen" : "browser";
    status.textContent = `Version ${api.VERSION} · Mode: ${standalone ? "Home Screen" : "Browser"}`;
  };
  render(api.isStandaloneDisplay());
  api.watchDisplayMode(render);

  // Demo/test hook only. Not part of the component API.
  window.__homeScreenInstallDemo = { api, instance };
}

start();
