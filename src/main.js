// Frndship Electron shell — main process
// Window shell, persistent session, offline fallback, nav guardrails.

const { app, BrowserWindow, session, shell, ipcMain, Menu, desktopCapturer, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const loopback = require('loopback-capture');

// Frame rate stays on Chromium's default, which follows the monitor's refresh
// rate. disable-frame-rate-limit would uncap it entirely.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-oop-rasterization');
app.commandLine.appendSwitch('use-angle', 'd3d11'); // Forces high-speed DirectX translation layer

// Global tracking variable for the active audio loopback instance
let activeAudioCapture = null;

// Silent by design: failed/unavailable update checks must never interrupt
// current app usage (see autoUpdater 'error' handler below). Downloads happen
// automatically once an update is found; the user is only ever prompted to
// restart, never to start the download.
autoUpdater.autoDownload = true;



function initAutoUpdate() {
  autoUpdater.on('update-downloaded', (_info) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-ready');
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
    // Fail silently — do not block or interrupt app usage.
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Auto-update check failed:', err);
  });
}

ipcMain.on('restart-and-install', () => {
  autoUpdater.quitAndInstall();
});

// No default File/Edit/View/Window/Help menu bar. Note: this also removes the
// default accelerators that ship with that menu (e.g. Ctrl+R) — those are
// re-registered manually where needed (see before-input-event below).
Menu.setApplicationMenu(null);

const APP_ORIGIN = 'https://frndship.app';
const DEV_ORIGIN = 'http://localhost:5173';
// Installed builds always load production. `npm start` loads the local dev
// server, or whatever origin FRNDSHIP_URL names.
const CONTENT_ORIGIN = app.isPackaged ? APP_ORIGIN : (process.env.FRNDSHIP_URL || DEV_ORIGIN);
const ALLOWED_ORIGINS = new Set(
  app.isPackaged ? [APP_ORIGIN] : [APP_ORIGIN, CONTENT_ORIGIN, DEV_ORIGIN, 'http://localhost:3000']
);
const LOGIN_URL = `${CONTENT_ORIGIN}/home`;
const CRASH_WINDOW_MS = 60 * 1000;
const MAX_CRASHES_IN_WINDOW = 3;
const SESSION_PARTITION = 'persist:frndship';
const APP_USER_MODEL_ID = 'app.frndship.desktop';

// Explicitly set the Windows AppUserModelId rather than relying on
// electron-builder's default. This doesn't do anything visible yet, but it
// matters later for grouping native notifications correctly in Action Center.
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// Ensure autoplay policy allows WebAudio worklets / voice isolation without gesture
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');


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
    return ALLOWED_ORIGINS.has(new URL(targetUrl).origin);
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

// Menu bar is hidden (see Menu.setApplicationMenu(null) above), so the default
// accelerators no longer exist. Attached to the shell window's webContents (in
// case a shortcut is pressed while focus is on the titlebar), the content
// webview, and popouts. getTarget returns the webContents the shortcut acts on.
function registerAppShortcuts(webContents, getTarget) {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const target = getTarget();
    if (!target) return;
    if (input.control && input.key.toLowerCase() === 'r') {
      target.reload();
    }
    // DevTools are for local development only, not installed builds.
    if (!app.isPackaged && ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12')) {
      target.toggleDevTools();
    }
  });
}

// Navigation rules shared by the content webview and any popouts it opens.
function attachContentGuards(webContents) {
  // Only allow same-origin navigation. Anything else (support docs, socials,
  // OAuth provider pages, etc.) opens in the user's default browser instead.
  webContents.on('will-navigate', (event, targetUrl) => {
    if (webContents === contentWebContents && isShowingOfflinePage) return; // allow local file loads/retries
    if (!isFrndshipUrl(targetUrl)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isFrndshipUrl(targetUrl)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1400,
          height: 900,
          frame: false,
          roundedCorners: true,
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#2a2a2a',
            symbolColor: '#ffffff',
            height: 32,
          },
          autoHideMenuBar: true,
          backgroundColor: '#0a0a0f',
          icon: path.join(__dirname, '..', 'build', 'icon.ico'),
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            partition: SESSION_PARTITION,
            additionalArguments: ['--is-secondary-window=true'],
          },
        },
      };
    }
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  webContents.on('did-create-window', (childWindow) => {
    attachContentGuards(childWindow.webContents);
    registerAppShortcuts(childWindow.webContents, () => childWindow.webContents);
    forwardFullscreenState(childWindow, () => [childWindow.webContents]);
    attachCrashRecovery(childWindow.webContents);
  });
}

// Reloads a crashed page back to where it was. A page that keeps crashing asks
// the user instead, so it can't get stuck in a reload loop.
function attachCrashRecovery(webContents) {
  let recentCrashes = [];
  webContents.on('render-process-gone', async (_event, details) => {
    console.error('Renderer process gone:', details.reason);
    if (details.reason === 'clean-exit' || webContents.isDestroyed()) return;

    const now = Date.now();
    recentCrashes = recentCrashes.filter((time) => now - time < CRASH_WINDOW_MS);
    recentCrashes.push(now);
    if (recentCrashes.length >= MAX_CRASHES_IN_WINDOW) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Frndship',
        message: 'Frndship keeps crashing',
        detail: 'Reload to try again, or quit and restart the app.',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) {
        app.quit();
        return;
      }
      recentCrashes = [];
    }
    if (!webContents.isDestroyed()) webContents.reload();
  });
}

// Tells the given webContents when a window enters or leaves fullscreen.
function forwardFullscreenState(win, getTargets) {
  const send = (enabled) => {
    getTargets().forEach((target) => {
      if (target && !target.isDestroyed()) target.send('window-fullscreen', enabled);
    });
  };
  win.on('enter-full-screen', () => send(true));
  win.on('leave-full-screen', () => send(false));
}

// The webview's webContents has no BrowserWindow of its own, so it maps to the
// main window. Popouts own their window.
function getWindowForContent(webContents) {
  return webContents === contentWebContents ? mainWindow : BrowserWindow.fromWebContents(webContents);
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
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    webPreferences.preload = path.join(__dirname, 'preload.js');
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.partition = SESSION_PARTITION;
    // Keep the game connected while alt-tabbed. The web app lowers its own frame
    // rate when the window isn't focused.
    webPreferences.backgroundThrottling = false;
    params.src = `${CONTENT_ORIGIN}/login`;
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
    // that decision entirely — the webview just loads /login (see
    // will-attach-webview above) and lets the site redirect authenticated users on its own. Keeps auth
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

    attachContentGuards(contentWebContents);

    // Back/forward button disabled state at history bounds.
    contentWebContents.on('did-navigate', sendNavState);
    contentWebContents.on('did-navigate-in-page', sendNavState);

    registerAppShortcuts(contentWebContents, () => contentWebContents);
    attachCrashRecovery(contentWebContents);
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', { maximized: false }));
  forwardFullscreenState(mainWindow, () => [mainWindow.webContents, contentWebContents]);

  mainWindow.on('closed', () => {
    mainWindow = null;
    contentWebContents = null;
  });

  // Input landing on the titlebar itself acts on the content webview.
  registerAppShortcuts(mainWindow.webContents, () => contentWebContents);
  attachCrashRecovery(mainWindow.webContents);
}

function setupPermissionHandler() {
  const ses = session.fromPartition(SESSION_PARTITION);
  // Allow media (camera/mic), pointerLock (in-game cursor lock), fullscreen, and
  // clipboard access (share links, copying and pasting in Networks) for our own
  // pages, deny everything else. This checks the top-level page, so iframes the
  // app embeds with an explicit allow attribute keep working.
  const ALLOWED_PERMISSIONS = new Set(['media', 'pointerLock', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read']);
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isFrndshipUrl(webContents.getURL()));
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
    initAutoUpdate();

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

  app.on('will-quit', () => {
    if (activeAudioCapture) {
      try { activeAudioCapture.stop(); } catch (e) { }
    }
  });
}

// Renderer (offline.html, via preload) asks main to retry loading the live
// site once the browser reports connectivity has returned. This is the
// "automatic recovery" path; the offline page's Retry button also uses this
// same channel. Preload also sends this from the live site whenever the
// connection returns, so ignore it unless the offline page is actually showing
// — otherwise a brief network drop would pull the user out of what they're in.
ipcMain.on('retry-connection', () => {
  if (isShowingOfflinePage) loadLoginPage();
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

// Native window fullscreen for the web app. Unlike HTML fullscreen, a tap of
// Esc doesn't exit it, so Esc only frees the cursor while in a world.
ipcMain.on('set-window-fullscreen', (event, enabled) => {
  const win = getWindowForContent(event.sender);
  if (win) win.setFullScreen(!!enabled);
});
ipcMain.handle('is-window-fullscreen', (event) => {
  const win = getWindowForContent(event.sender);
  return !!win && win.isFullScreen();
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

ipcMain.on('start-app-audio', (event, targetWindowId) => {
  // 1. Clean up any existing capture session
  if (activeAudioCapture) {
    try { activeAudioCapture.stop(); } catch (e) { }
    activeAudioCapture = null;
  }

  // 2. Parse the native HWND from Chromium's desktopCapturer format ("window:HWND:0")
  const idParts = targetWindowId.split(':');
  if (idParts[0] !== 'window' || !idParts[1]) {
    console.error('Invalid source ID format for application audio isolation.');
    return;
  }
  const hwnd = parseInt(idParts[1], 10);

  // 3. Securely convert HWND to Process ID (PID) using PowerShell
  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$pidOut = 0
[Win32]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$pidOut) | Out-Null
Write-Output $pidOut
  `;

  // Base64 encode for UTF-16LE as required by powershell -EncodedCommand
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  require('child_process').exec(`powershell -NoProfile -EncodedCommand ${encoded}`, (err, stdout) => {
    if (err) {
      console.error('Failed to resolve PID from HWND:', err);
      return;
    }

    const pid = parseInt(stdout.trim(), 10);
    if (!pid || pid === 0) {
      console.error('Resolved invalid PID from HWND.');
      return;
    }

    console.log(`Initializing WASAPI application loopback for PID: ${pid} (from HWND ${hwnd})`);

    try {
      activeAudioCapture = new loopback.LoopbackCapture();

      // 4. Start capture and pipe the raw PCM Buffer chunks over IPC
      activeAudioCapture.start(pid, true, (chunk) => {
        if (contentWebContents && !contentWebContents.isDestroyed()) {
          contentWebContents.send('app-audio-chunk', chunk);
        }
      });
    } catch (captureErr) {
      console.error('Failed to initialize WASAPI loopback engine:', captureErr);
    }
  });
});

ipcMain.on('stop-app-audio', () => {
  if (activeAudioCapture) {
    console.log('Stopping WASAPI application loopback engine.');
    try { activeAudioCapture.stop(); } catch (e) { }
    activeAudioCapture = null;
  }
});

ipcMain.handle('get-desktop-sources', async () => {
  // Get all available screens and windows
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 300, height: 300 }
  });

  // Format them for our React Modal
  return sources.map(source => ({
    id: source.id,
    name: source.name,
    // Convert the native image thumbnail to a base64 string React can render
    thumbnail: source.thumbnail.toDataURL()
  }));
});


