// Frndship Electron shell — preload script
// Runs in an isolated context (contextIsolation: true) with a minimal bridge.

const { contextBridge, ipcRenderer } = require('electron');

console.log('[Electron Preload] 🚀 preload.js loaded in webview!');

contextBridge.exposeInMainWorld('isElectronApp', true);
contextBridge.exposeInMainWorld(
  'isSecondaryWindow',
  process.argv.includes('--is-secondary-window=true')
);

contextBridge.exposeInMainWorld('frndship', {
  // Manual "Retry" button on the offline page calls this.
  retryConnection: () => ipcRenderer.send('retry-connection'),
});

// frndship:// links handed over by main. One can arrive before the web app is
// ready to handle it (e.g. still signing in), so the latest is held until then.
let pendingLink = null;
let linkListener = null;
ipcRenderer.on('open-link', (_event, linkPath) => {
  if (linkListener) linkListener(linkPath);
  else pendingLink = linkPath;
});

contextBridge.exposeInMainWorld('electron', {
  onOpenLink: (callback) => {
    linkListener = callback;
    if (pendingLink) {
      callback(pendingLink);
      pendingLink = null;
    }
    return () => {
      if (linkListener === callback) linkListener = null;
    };
  },
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  isDesktopApp: true,
  setWindowFullscreen: (enabled) => ipcRenderer.send('set-window-fullscreen', enabled),
  isWindowFullscreen: () => ipcRenderer.invoke('is-window-fullscreen'),
  onWindowFullscreenChange: (callback) => {
    const subscription = (_event, enabled) => callback(enabled);
    ipcRenderer.on('window-fullscreen', subscription);
    return () => ipcRenderer.removeListener('window-fullscreen', subscription);
  },
});

contextBridge.exposeInMainWorld('frndshipNativeAudio', {
  // Controls to start and stop the WASAPI hook
  startCapture: (sourceId) => ipcRenderer.send('start-app-audio', sourceId),
  stopCapture: () => ipcRenderer.send('stop-app-audio'),
  
  // Listener for incoming PCM ArrayBuffers
  onAudioChunk: (callback) => {
    const subscription = (_event, chunkData) => {
      // Electron IPC sends Node Buffers as Uint8Array. Extract the exact
      // ArrayBuffer slice so React doesn't get a huge 8KB node slab.
      const preciseArrayBuffer = chunkData.buffer.slice(
        chunkData.byteOffset, 
        chunkData.byteOffset + chunkData.byteLength
      );
      callback(preciseArrayBuffer);
    };
    ipcRenderer.on('app-audio-chunk', subscription);
    
    // Return an unsubscribe function to prevent memory leaks in React
    return () => ipcRenderer.removeListener('app-audio-chunk', subscription);
  }
});

// Automatic recovery: as soon as the OS/browser reports connectivity is back,
// ask main to retry loading the live site instead of requiring the user to
// click Retry. This fires in whichever page (offline.html or the live site)
// happens to be loaded when connectivity changes; main ignores it unless the
// offline page is showing.
window.addEventListener('online', () => {
  ipcRenderer.send('retry-connection');
});
