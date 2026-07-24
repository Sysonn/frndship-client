// Frndship Electron shell — preload script
// Runs in an isolated context (contextIsolation: true) with a minimal bridge.
// Sprint 1 only needs a way for the offline page to ask main to retry the
// live site, plus automatic recovery when the renderer's online event fires.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frndship', {
  // Manual "Retry" button on the offline page calls this.
  retryConnection: () => ipcRenderer.send('retry-connection'),
});

contextBridge.exposeInMainWorld('electron', {
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources')
});

// Automatic recovery: as soon as the OS/browser reports connectivity is back,
// ask main to retry loading the live site instead of requiring the user to
// click Retry. This fires in whichever page (offline.html or the live site)
// happens to be loaded when connectivity changes; it's a no-op harmless send
// if the live site is already showing.
window.addEventListener('online', () => {
  ipcRenderer.send('retry-connection');
});
