'use strict';

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await browser.storage.local.get(['remoteEnabled', 'token', 'allowlist', 'scope', 'useWs']);
  $('enabled').checked = s.remoteEnabled !== false;
  $('token').value = s.token || '';
  $('allowlist').value = (s.allowlist || []).join(', ');
  $('scope').value = s.scope || 'data';
  $('useWs').checked = !!s.useWs;
  updateStatus();
}

async function updateStatus() {
  try {
    const r = await fetch('https://capture.eemaill.codes/api/bridge/poll?token=' +
      encodeURIComponent($('token').value || ''), { cache: 'no-store' });
    if (r.ok) {
      const cfg = await r.json();
      $('status').innerHTML = '<span class="on">● Connected</span> · session ' + (cfg.sessionId || '?') +
        '<br>capture: ' + (cfg.captureEnabled ? 'on' : 'off') + ' · scope: ' + (cfg.scope || 'data');
    } else {
      $('status').innerHTML = '<span class="off">● Token invalid (HTTP ' + r.status + ')</span>';
    }
  } catch (e) {
    $('status').innerHTML = '<span class="off">● Cannot reach server (Tor?)</span>';
  }
}

$('save').addEventListener('click', async () => {
  const allowlist = $('allowlist').value.split(',').map(x => x.trim()).filter(Boolean);
  await browser.storage.local.set({
    remoteEnabled: $('enabled').checked,
    token: $('token').value.trim(),
    allowlist,
    scope: $('scope').value,
    useWs: $('useWs').checked,
  });
  // notify background to re-init transport
  browser.runtime.sendMessage({ kind: 'popup-saved' }).catch(() => {});
  $('status').textContent = 'Saved. Reconnecting…';
  setTimeout(updateStatus, 1500);
});

$('cleartoken').addEventListener('click', async () => {
  await browser.storage.local.set({ token: '' });
  $('token').value = '';
  $('status').textContent = 'Token cleared.';
});

load();
setInterval(updateStatus, 10000);
