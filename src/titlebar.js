// Titlebar renderer script (runs in shell.html, not inside the <webview>).
// Uses the windowControls API exposed by shell-preload.js.

const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnRefresh = document.getElementById('btn-refresh');
const btnMin = document.getElementById('btn-min');
const btnMax = document.getElementById('btn-max');
const btnClose = document.getElementById('btn-close');
const dragRegion = document.getElementById('drag-region');

btnBack.addEventListener('click', () => window.windowControls.goBack());
btnForward.addEventListener('click', () => window.windowControls.goForward());
btnRefresh.addEventListener('click', () => window.windowControls.refresh());
btnMin.addEventListener('click', () => window.windowControls.minimize());
btnMax.addEventListener('click', () => window.windowControls.maximize());
btnClose.addEventListener('click', () => window.windowControls.close());

// Double-click on the drag region to maximize/restore. On Windows, Chromium
// already does this natively for -webkit-app-region: drag elements, but we
// wire it explicitly too so behavior is consistent and not dependent on that
// implicit default.
dragRegion.addEventListener('dblclick', () => window.windowControls.maximize());

// Maximize/restore icon + tooltip state, pushed from main.js.
window.windowControls.onWindowState(({ maximized }) => {
  btnMax.innerHTML = maximized ? '&#10066;' : '&#9634;'; // restore vs maximize glyph
  btnMax.title = maximized ? 'Restore' : 'Maximize';
});

// Back/forward disabled state at history bounds, pushed from main.js on
// did-navigate / did-navigate-in-page of the content <webview>.
window.windowControls.onNavState(({ canGoBack, canGoForward }) => {
  btnBack.disabled = !canGoBack;
  btnForward.disabled = !canGoForward;
});

// Buttons start disabled until the first nav-state update arrives.
btnBack.disabled = true;
btnForward.disabled = true;

// Update-ready banner: shown once main.js confirms a downloaded update is
// waiting. Purely informational until the user clicks Restart — never
// auto-restarts on its own.
const updateBanner = document.getElementById('update-banner');
const btnUpdateRestart = document.getElementById('btn-update-restart');

window.updater.onUpdateReady(() => {
  updateBanner.hidden = false;
});

btnUpdateRestart.addEventListener('click', () => {
  window.updater.restartAndInstall();
});
