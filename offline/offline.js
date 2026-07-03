// Offline page script — no external requests, must work with zero connectivity.
const statusEl = document.getElementById('status');

document.getElementById('retry-btn').addEventListener('click', () => {
  window.frndship.retryConnection();
});

// Automatic recovery is also wired in preload.js via the 'online' event on
// this window; this just gives the user a small status hint on the page.
window.addEventListener('online', () => {
  statusEl.textContent = 'Connection detected, reconnecting…';
});
window.addEventListener('offline', () => {
  statusEl.textContent = '';
});
