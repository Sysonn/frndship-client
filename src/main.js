// Frndship Electron shell — main process
// Sprint 1: window shell, persistent session, offline fallback, basic nav guardrails.
// Windows-first this sprint, but nothing here is Windows-specific — platform
// branching (macOS/Linux) can be added later without restructuring this file.

const { app, BrowserWindow, session, shell, ipcMain, Menu } = require('electron');
const path = require('path');
const url = require('url');

// No default File/Edit/View/Window/Help menu bar. Note: this also removes the
// default accelerators that ship with that menu (e.g. Ctrl+R) — those are
// re-registered manually where needed (see before-input-event below).
Menu.setApplicationMenu(null);

const APP_ORIGIN = 'https://frndship.app';
const LOGIN_URL = `${APP_ORIGIN}/home`;
const SESSION_PARTITION = 'persist:frndship';
const APP_USER_MODEL_ID = 'app.frndship.desktop';

// Explicitly set the Windows AppUserModelId rather than relying on
// electron-builder's default. This doesn't do anything visible yet, but it
// matters later for grouping native notifications correctly in Action Center.
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}


// Chromium net-error codes that indicate a genuine connectivity failure
// (as opposed to e.g. a 404/500 from the site itself, which Chromium does NOT
// report through did-fail-load with these codes — those render as normal pages).
// https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h
const NETWORK_FAILURE_CODES = new Set([
  -2, // ERR_FAILED (generic, still usually network-related at this stage)
  -6, // ERR_FILE_NOT_FOUND (can occur if loadFile path resolution fails)
  -21, // ERR_NETWORK_CHANGED
  -100, // ERR_CONNECTION_CLOSED
  -101, // ERR_CONNECTION_RESET
  -102, // ERR_CONNECTION_REFUSED
  -104, // ERR_CONNECTION_FAILED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -109, // ERR_ADDRESS_UNREACHABLE
  -118, // ERR_CONNECTION_TIMED_OUT
  -138, // ERR_NETWORK_ACCESS_DENIED
  -501, // ERR_INSECURE_RESPONSE (TLS chain issues while offline/captive portal)
]);

let mainWindow = null;
// webContents of the <webview> that actually loads frndship.app — the shell
// window itself only hosts the local titlebar HTML. All navigation, offline
// fallback, and history logic below targets this, not mainWindow.webContents.
let contentWebContents = null;
let isShowingOfflinePage = false;

function isFrndshipUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function loadOfflinePage() {
  if (!contentWebContents) return;
  isShowingOfflinePage = true;
  contentWebContents.loadFile(path.join(__dirname, '..', 'offline', 'offline.html'));
}

function loadLoginPage() {
  if (!contentWebContents) return;
  isShowingOfflinePage = false;
  contentWebContents.loadURL(LOGIN_URL);
}

function sendNavState() {
  if (!contentWebContents || !mainWindow) return;
  mainWindow.webContents.send('nav-state', {
    canGoBack: contentWebContents.canGoBack(),
    canGoForward: contentWebContents.canGoForward(),
  });
}

// Shared so it can be attached both to the shell window's webContents (in
// case a shortcut is pressed while focus is on the titlebar) and to the
// content webview's webContents (attached once it exists, see
// did-attach-webview below).
function registerReloadShortcut(webContents) {
  webContents.on('before-input-event', (event, input) => {
    if (input.control && input.key.toLowerCase() === 'r' && input.type === 'keyDown') {
      if (contentWebContents) contentWebContents.reload();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    frame: false,
    // Windows 11 rounds frameless window corners by default when this is left
    // on (the default), but it's set explicitly here since it's load-bearing
    // for the "no native frame, still rounded corners" acceptance criterion.
    roundedCorners: true,
    backgroundColor: '#0a0a0f',
    // win.icon in package.json's build config only brands the packaged .exe.
    // Set it here too so `npm start` (unpackaged dev run) also shows the real
    // icon in the taskbar instead of Electron's default.
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The titlebar wrapper hosts a <webview> that loads the actual
      // frndship.app content — needs to be explicitly enabled.
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Shell wrapper hosts only the local titlebar HTML; frndship.app itself
  // loads inside the <webview> defined in shell.html.
  mainWindow.loadFile(path.join(__dirname, 'shell.html'));

  // Enforce the real preload/partition for the content <webview> from the
  // main process rather than trusting shell.html's own markup attributes —
  // this is the persistent partition behind "stay logged in" (see
  // SESSION_PARTITION comment near the top of this file). Do NOT switch to an
  // in-memory partition and do NOT call session.clearStorageData() anywhere
  // in the lifecycle.
  //
  // If the site's auth model ever needs the native shell to read/write a
  // token directly (e.g. to authorize a future native notification push),
  // that's a separate decision for a later sprint (safeStorage / keytar), not
  // handled here.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'preload.js');
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.partition = SESSION_PARTITION;
  });

  mainWindow.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    contentWebContents = guestWebContents;

    // Placeholder for future CSP lockdown. For this sprint we rely on
    // navigation guardrails below rather than a full Content-Security-Policy
    // header, since the page content itself is served by frndship.app, not by
    // us. TODO(later sprint): inject/tighten CSP via onHeadersReceived once
    // the site's asset/script origins are finalized.

    // Intentional: Electron does NOT inspect cookies/session state or decide
    // between /login and /home here. The web app's client-side routing owns
    // that decision entirely — the webview just loads /login (see shell.html)
    // and lets the site redirect authenticated users on its own. Keeps auth
    // routing in one place.

    contentWebContents.on('did-fail-load', (_e, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // Don't treat the offline page's own load (or a retry) as a further failure loop.
      if (isShowingOfflinePage) return;
      if (NETWORK_FAILURE_CODES.has(errorCode)) {
        loadOfflinePage();
      }
      // Non-network failures (e.g. HTTP-level errors) are left to render as
      // whatever the server/Chromium normally shows; we only intercept true
      // connectivity failures.
    });

    // Navigation guardrail: only allow same-origin navigation inside the
    // webview. Anything else (support docs, socials, OAuth provider pages,
    // etc.) opens in the user's default browser instead.
    contentWebContents.on('will-navigate', (event, targetUrl) => {
      if (isShowingOfflinePage) return; // allow local file loads/retries
      if (!isFrndshipUrl(targetUrl)) {
        event.preventDefault();
        shell.openExternal(targetUrl);
      }
    });

    contentWebContents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (isFrndshipUrl(targetUrl)) {
        return { action: 'allow' };
      }
      shell.openExternal(targetUrl);
      return { action: 'deny' };
    });

    // Back/forward button disabled state at history bounds.
    contentWebContents.on('did-navigate', sendNavState);
    contentWebContents.on('did-navigate-in-page', sendNavState);

    // Menu bar is hidden (see Menu.setApplicationMenu(null) above), so the
    // default Ctrl+R reload accelerator no longer exists — re-register it
    // manually, for input that lands inside the webview's own content.
    registerReloadShortcut(contentWebContents);
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', { maximized: false }));

  mainWindow.on('closed', () => {
    mainWindow = null;
    contentWebContents = null;
  });

  // Also re-register Ctrl+R for input landing on the titlebar itself (this is
  // the place to add other manual shortcuts later if the menu stays hidden
  // long-term, e.g. Ctrl+Shift+I for devtools).
  registerReloadShortcut(mainWindow.webContents);
}

function setupPermissionHandler() {
  const ses = session.fromPartition(SESSION_PARTITION);
  // Stub permission handler: allow media (camera/mic), pointerLock (in-game
  // cursor lock), and fullscreen for now, deny everything else by default.
  // This is where granular per-permission gating (camera vs mic vs
  // notifications, per-origin prompts, etc.) will live in a later sprint.
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'pointerLock' || permission === 'fullscreen') {
      callback(true);
      return;
    }
    callback(false);
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    setupPermissionHandler();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

// Renderer (offline.html, via preload) asks main to retry loading the live
// site once the browser reports connectivity has returned. This is the
// "automatic recovery" path; the offline page's Retry button also uses this
// same channel.
ipcMain.on('retry-connection', () => {
  loadLoginPage();
});

// Titlebar window controls (see shell-preload.js / titlebar.js).
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// Titlebar nav controls target the content <webview>'s webContents, not the
// shell wrapper window.
ipcMain.on('nav-back', () => {
  if (contentWebContents && contentWebContents.canGoBack()) contentWebContents.goBack();
});
ipcMain.on('nav-forward', () => {
  if (contentWebContents && contentWebContents.canGoForward()) contentWebContents.goForward();
});
ipcMain.on('nav-refresh', () => {
  if (contentWebContents) contentWebContents.reload();
});
