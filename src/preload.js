// Frndship Electron shell — preload script
// Runs in an isolated context (contextIsolation: true) with a minimal bridge.
// Sprint 1 only needs a way for the offline page to ask main to retry the
// live site, plus automatic recovery when the renderer's online event fires.

const { contextBridge, ipcRenderer } = require('electron');

console.log('[Electron Preload] 🚀 preload.js loaded in webview!');

contextBridge.exposeInMainWorld('isElectronApp', true);

contextBridge.exposeInMainWorld('frndship', {
  // Manual "Retry" button on the offline page calls this.
  retryConnection: () => ipcRenderer.send('retry-connection'),
});

contextBridge.exposeInMainWorld('electron', {
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  isDesktopApp: true,
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
// happens to be loaded when connectivity changes; it's a no-op harmless send
// if the live site is already showing.
window.addEventListener('online', () => {
  ipcRenderer.send('retry-connection');
});
