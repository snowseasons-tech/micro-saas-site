'use strict';
const $ = id => document.getElementById(id);
let applications = [];
function status(message) { $('status').textContent = message; }
async function api(path, options = {}) {
  const response = await fetch('/api' + path, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) signedOut();
    throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`);
  }
  return data;
}
function signedOut() {
  applications = [];
  $('login').hidden = false; $('account').hidden = true; $('logout').hidden = true;
  $('search').disabled = true; $('category').disabled = true;
  $('catalog').textContent = 'Sign in to view the application catalog.';
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function render() {
  const query = $('search').value.toLowerCase();
  const visible = applications.filter(a => (a.name + ' ' + a.description).toLowerCase().includes(query) && (!$('category').value || a.category === $('category').value));
  $('catalog').replaceChildren();
  if (!visible.length) $('catalog').append(node('p', 'No applications match. Your administrator can publish packages for this workspace.', 'muted'));
  for (const a of visible) {
    const card = node('article', undefined, 'app-card');
    card.append(node('span', a.entitled ? 'ACCESS ACTIVE' : 'ACCESS REQUIRED', 'badge'), node('h3', a.name), node('p', a.description));
    if (!a.releases.length) card.append(node('p', 'No releases published yet.', 'muted'));
    for (const r of a.releases) {
      const details = node('details', undefined, 'release');
      details.append(node('summary', `v${r.version} · ${r.platform} · ${r.channel}`), node('p', `${r.filename} · ${(r.size / 1048576).toFixed(2)} MB`), node('pre', r.notes || 'No release notes provided.'), node('code', `SHA-256: ${r.sha256}`));
      const button = node('button', a.entitled ? 'Download package ↓' : 'Contact administrator for access', 'btn btn-primary');
      button.disabled = !a.entitled;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await api(`/releases/${r.id}/download`, { method: 'POST' });
          const url = new URL(result.url);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid download URL');
          // Browser navigation downloads the private object; credentials stay HttpOnly.
          const link = node('a'); link.href = url.href; link.rel = 'noreferrer'; link.referrerPolicy = 'no-referrer';
          document.body.append(link); link.click(); link.remove();
          status('Download link issued. Verify SHA-256 before installing.');
        } catch (error) { status(error.message); }
        finally { button.disabled = !a.entitled; }
      });
      details.append(button); card.append(details);
    }
    $('catalog').append(card);
  }
}
async function load() {
  const user = await api('/me');
  applications = await api('/applications');
  $('login').hidden = true; $('account').hidden = false; $('logout').hidden = false;
  $('email').textContent = user.email; $('search').disabled = false; $('category').disabled = false;
  $('category').replaceChildren(node('option', 'All categories'));
  $('category').firstChild.value = '';
  for (const category of [...new Set(applications.map(a => a.category))].sort()) {
    const option = node('option', category); option.value = category; $('category').append(option);
  }
  render();
}
$('login').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    event.target.reset(); await load(); status('Workspace ready.');
  } catch (error) { status(error.message); }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); signedOut(); status('Signed out.'); }
  catch (error) { status(error.message); }
});
$('search').addEventListener('input', render); $('category').addEventListener('change', render);
load().catch(error => { if (error.message !== 'Sign in required') status(error.message); });
