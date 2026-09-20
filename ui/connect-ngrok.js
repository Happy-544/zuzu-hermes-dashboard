'use strict';
(() => {
  let key = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  const form = document.querySelector('#setup');
  const token = document.querySelector('#token');
  const save = document.querySelector('#save');
  const status = document.querySelector('#status');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) {
    save.disabled = true;
    status.textContent = 'Open the complete setup link from your chat. Refreshing removes its one-time key.';
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    status.textContent = 'Saving on your PC…';
    try {
      const response = await fetch('/api/setup/ngrok', {
        method: 'POST', cache: 'no-store', credentials: 'omit',
        headers: {'Content-Type': 'application/json', 'X-Setup-Key': key},
        body: JSON.stringify({token: token.value.trim()})
      });
      token.value = '';
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Setup failed.');
      key = '';
      form.hidden = true;
      status.textContent = result.message;
    } catch (error) {
      token.value = '';
      status.textContent = error.message || 'Connection failed. Please try again.';
      save.disabled = false;
    }
  });
})();
