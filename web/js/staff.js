// Login, plus coordinator/admin actions: keyword editing and "Check now".
import { toast } from './util.js';
import { getProgram, locateFile } from './model.js';
import { post, login, getSession, setSession, clearCaches, writeCache, cleanKeywords, isStaff } from './api.js';

// ── Login ───────────────────────────────────────────────────
export async function handleLogin(form, app) {
  if (form.dataset.busy === '1') return;
  const input = form.querySelector('input[name=pin]');
  const status = form.querySelector('.form-status');
  const button = form.querySelector('button[type=submit]');
  const pin = String(input.value || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(pin)) {
    status.className = 'form-status error';
    status.textContent = 'Enter all 6 digits.';
    input.focus();
    return;
  }
  form.dataset.busy = '1';
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = 'Checking…';
  const res = await login(pin);
  form.dataset.busy = '';
  button.disabled = false;
  if (!res.ok) {
    status.className = 'form-status error';
    status.textContent = res.error === 'locked' ? 'Too many wrong PINs. Wait 5 minutes, then try again.'
      : res.message || 'Login failed.';
    input.value = '';
    input.focus();
    return;
  }
  clearCaches();
  setSession({ token: res.token, role: res.role, name: res.name, expiresAt: res.expiresAt });
  toast(`Welcome, ${res.name}!`);
  app.onLogin();
}

// ── Keywords ────────────────────────────────────────────────
export async function handleSaveKeywords(form, app) {
  const progCode = form.dataset.prog;
  const fileId = form.dataset.fileId;
  const prog = getProgram(progCode);
  const status = form.querySelector('.kw-status');
  const input = form.querySelector('input[name=keywords]');
  const button = form.querySelector('button[type=submit]');
  if (!isStaff()) { status.className = 'kw-status error'; status.textContent = 'Please log in again.'; return; }
  const cleaned = cleanKeywords(input.value);
  button.disabled = true;
  status.className = 'kw-status';
  status.textContent = 'Saving…';
  const res = await post(prog, { action: 'saveKeywords', fileId, keywords: cleaned.join(', ') });
  button.disabled = false;
  if (!res.ok) {
    status.className = 'kw-status error';
    status.textContent = res.error === 'busy' ? 'The server is busy updating. Please try again in a few seconds.'
      : res.message || 'Could not save.';
    return;
  }
  input.value = res.keywords.join(', ');
  input.defaultValue = input.value; // lets "Check now" tell saved from unsaved keywords
  status.className = 'kw-status ok';
  status.textContent = '✓ Saved';
  setTimeout(() => { if (status.textContent === '✓ Saved') status.textContent = ''; }, 4000);
  // Update the local copy so search sees the new keywords right away.
  const snap = app.state.snaps[progCode];
  if (snap) {
    for (const hit of locateFile(snap, fileId)) hit.file.keywords = res.keywords;
    writeCache(progCode, snap);
    app.reindex();
  }
}

// ── Check now (rescan Drive after uploading) ────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileIds(snap) {
  const ids = new Set();
  for (const f of snap?.looseFiles || []) ids.add(f.id);
  for (const area of snap?.areas || []) {
    for (const f of area.looseFiles || []) ids.add(f.id);
    for (const pa of area.parameters) {
      for (const f of pa.looseFiles || []) ids.add(f.id);
      for (const ind of pa.indicators) for (const f of ind.files) ids.add(f.id);
    }
  }
  return ids;
}

export async function checkNow(progCode, button, app) {
  const prog = getProgram(progCode);
  const status = document.getElementById('chk-status');
  if (!prog || !getSession() || !status) return;

  // Re-rendering clears keyword boxes, so don't throw away unsaved typing silently.
  const dirty = [...document.querySelectorAll('.kw-form input[name=keywords]')].some((i) => i.value !== i.defaultValue);
  if (dirty && button.dataset.confirm !== '1') {
    button.dataset.confirm = '1';
    status.className = 'form-status error';
    status.textContent = 'You have unsaved keywords. Save them first, or tap Check now again to discard them.';
    setTimeout(() => { button.dataset.confirm = ''; }, 6000);
    return;
  }

  const before = fileIds(app.state.snaps[progCode]);
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = 'Checking Google Drive… (about 10 seconds)';

  let res = await post(prog, { action: 'checkNow' });
  if (!res.ok && res.error === 'busy') {
    // An automatic scan is already running; wait for it, then try once more.
    status.textContent = 'Another check is running. Waiting…';
    await sleep(8000);
    res = await post(prog, { action: 'checkNow' });
    if (!res.ok && res.error === 'busy') res = { ok: true };
  }
  if (!res.ok && res.error === 'network') res = { ok: true, slow: true }; // the scan may still finish; reload anyway

  if (!res.ok) {
    button.disabled = false;
    status.className = 'form-status error';
    status.textContent = res.message || 'Check failed.';
    return;
  }

  await app.refresh(progCode, true);
  app.state.touched = false;
  app.render();

  const after = fileIds(app.state.snaps[progCode]);
  const added = [...after].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.has(id)).length;
  const parts = [];
  if (added) parts.push(`${added} new file${added > 1 ? 's' : ''}`);
  if (removed) parts.push(`${removed} removed`);
  const box = document.getElementById('chk-status');
  if (box) {
    box.className = 'form-status ok';
    box.textContent = parts.length ? `✓ Updated: ${parts.join(', ')}.`
      : res.slow ? 'The server was slow. If your files are missing, wait a minute and check again.'
      : '✓ Up to date. If you just uploaded, wait until Drive finishes, then check again.';
  }
  if (added) toast(`✓ ${added} new file${added > 1 ? 's' : ''} found.`);
}
