// Preload for the shell wrapper window (shell.html / titlebar), NOT the
// <webview> that loads frndship.app. Separate from src/preload.js, which is
// enforced onto the webview's content process via 'will-attach-webview' in
// main.js.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  goBack: () => ipcRenderer.send('nav-back'),
  goForward: () => ipcRenderer.send('nav-forward'),
  refresh: () => ipcRenderer.send('nav-refresh'),

  // Subscriptions: main process pushes state, titlebar.js updates the DOM.
  onWindowState: (callback) => {
    ipcRenderer.on('window-state', (_event, state) => callback(state));
  },
  onNavState: (callback) => {
    ipcRenderer.on('nav-state', (_event, state) => callback(state));
  },
});
