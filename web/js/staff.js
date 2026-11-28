// Login, plus coordinator/admin actions: keyword editing and "Check now".
import { toast, esc } from './util.js';
import { getProgram, locateFile } from './model.js';
import * as V from './views.js';
import { post, login, getSession, setSession, clearCaches, writeCache, cleanKeywords, isStaff, mainProgram } from './api.js';

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
  // Accreditors get the welcome pop-up (see syncWelcome in app.js) instead of the toast.
  if (res.role !== 'accreditor') toast(`Welcome, ${res.name}!`);
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
  toast('✓ Keywords saved.');
  // Update the local copy so search sees the new keywords right away (no redraw: the open document stays put).
  const snap = app.state.snaps[progCode];
  if (snap) {
    for (const hit of locateFile(snap, fileId)) hit.file.keywords = res.keywords;
    // This copy now matches the server's new version, if it matched the one just before the save:
    // take the new hashes, so the next refresh doesn't download the whole file list again.
    if (res.hashFrom && snap.hash === res.hashFrom) snap.hash = res.hashTo;
    if (res.refHashFrom && snap.refHash === res.refHashFrom) {
      if (snap.refLoaded === res.refHashFrom) snap.refLoaded = res.refHashTo;
      snap.refHash = res.refHashTo;
    }
    writeCache(progCode, snap);
    app.reindex();
  }
}

// ── Requested Documents: who a file is for ──────────────────
// The accreditor names live in the main program (Access tab). Loaded once per page visit.
let namesPromise = null;
function accreditorNames() {
  if (!namesPromise) {
    namesPromise = post(mainProgram(), { action: 'accreditors' }).then((res) => {
      if (!res.ok || !Array.isArray(res.names)) { namesPromise = null; throw new Error(res.message || 'Could not load the accreditors.'); }
      return res.names;
    }, (err) => { namesPromise = null; throw err; });
  }
  return namesPromise;
}

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** "👤 Accreditors": open or close the picker; fill in the names the first time. */
export async function toggleRequestForm(button) {
  const form = button.closest('[data-req-scope]')?.querySelector('.req-form');
  if (!form) return;
  form.hidden = !form.hidden;
  if (form.hidden || form.dataset.loaded === '1') return;
  const list = form.querySelector('[data-req-list]');
  const save = form.querySelector('button[type=submit]');
  let names;
  try {
    names = await accreditorNames();
  } catch (err) {
    list.innerHTML = `<span class="error small">${esc(err.message || 'Could not load the accreditors.')}</span>
      <button type="button" class="linklike small" data-action="req-retry">Try again</button>`;
    return;
  }
  if (!form.isConnected) return;
  let current = [];
  try { current = JSON.parse(form.dataset.current || '[]'); } catch { current = []; }
  // Names ticked earlier that are no longer in the Access tab (renamed or removed): listed so they can be unticked.
  const gone = current.filter((c) => !names.some((n) => sameName(n, c)));
  const box = (name, note) => `<label class="req-name"><input type="checkbox" name="acc" value="${esc(name)}"
      ${current.some((c) => sameName(c, name)) ? 'checked' : ''}> <span>${esc(name)}</span>${note ? ` <small class="muted">${note}</small>` : ''}</label>`;
  list.innerHTML = names.length || gone.length
    ? names.map((n) => box(n, '')).join('') + gone.map((n) => box(n, '(not in the Access tab any more)')).join('')
    : '<span class="muted small">No accreditors yet. The admin adds them in the main program’s Access tab.</span>';
  form.dataset.loaded = '1';
  save.disabled = false;
}

export function retryRequestNames(button) {
  const form = button.closest('.req-form');
  const toggle = form?.closest('[data-req-scope]')?.querySelector('[data-action="req-toggle"]');
  if (!form || !toggle) return;
  form.hidden = true; // toggleRequestForm opens it again and reloads the names
  toggleRequestForm(toggle);
}

export async function handleSaveRequest(form, app) {
  const progCode = form.dataset.prog;
  const fileId = form.dataset.fileId;
  const prog = getProgram(progCode);
  const status = form.querySelector('.kw-status');
  const button = form.querySelector('button[type=submit]');
  if (!isStaff()) { status.className = 'kw-status error'; status.textContent = 'Please log in again.'; return; }
  const names = [...form.querySelectorAll('input[name=acc]:checked')].map((c) => c.value);
  button.disabled = true;
  status.className = 'kw-status';
  status.textContent = 'Saving…';
  const res = await post(prog, { action: 'saveRequestAccess', fileId, accreditors: names });
  button.disabled = false;
  if (!res.ok) {
    status.className = 'kw-status error';
    status.textContent = res.error === 'busy' ? 'The server is busy updating. Please try again in a few seconds.'
      : res.message || 'Could not save.';
    return;
  }
  form.dataset.current = JSON.stringify(res.accreditors);
  status.className = 'kw-status ok';
  status.textContent = '✓ Saved';
  setTimeout(() => { if (status.textContent === '✓ Saved') status.textContent = ''; }, 4000);
  toast(res.accreditors.length ? `✓ Shown to ${res.accreditors.join(', ')} only.` : '✓ Saved. No accreditor sees this file now.');
  const snap = app.state.snaps[progCode];
  if (!snap) return;
  let file = null;
  for (const hit of locateFile(snap, fileId)) { hit.file.for = res.accreditors; file = hit.file; }
  if (res.hashFrom && snap.hash === res.hashFrom) snap.hash = res.hashTo;
  writeCache(progCode, snap);
  // Update the "For:" line and the tree marks without reloading the open document.
  const line = form.closest('.viewer-bar')?.querySelector('.req-for');
  if (file && line) line.outerHTML = V.requestForLine(file);
  redrawTree(app);
  app.state.touched = false;
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

/** Swap in a fresh tree and staff tools, leaving the open document alone. */
function redrawTree(app) {
  const { html, workspace } = V.renderWorkspace(app.state, app.state.route, '');
  if (!workspace) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const scroller = document.getElementById('treeScroll');
  const top = scroller ? scroller.scrollTop : 0;
  for (const sel of ['.tree-staff', '#tree']) {
    const fresh = tpl.content.querySelector(sel);
    const old = document.querySelector(sel);
    if (fresh && old) old.replaceWith(fresh);
  }
  if (scroller) scroller.scrollTop = top;
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
  if (!getSession()) return;
  const st = app.state.status[progCode] || {};
  if (st.noAccess) {
    app.state.touched = false;
    app.render();
    toast('This program is no longer open to your PIN.', 'error');
    return;
  }
  if (st.error) {
    // refresh() may already have redrawn the page, so look the status box up again.
    button.disabled = false;
    const box = document.getElementById('chk-status');
    if (box) {
      box.className = 'form-status error';
      box.textContent = 'Drive was checked, but the updated list could not be loaded. Try again.';
    }
    return;
  }

  // Rebuilding the page would reload the open document, so only redraw the tree then.
  const r = app.state.route;
  const viewing = r && r.name === 'workspace' && r.prog === progCode && r.fileId && (r.q || '').trim().length < 2
    && document.querySelector(`.viewer-frame[data-file="${CSS.escape(r.fileId)}"]`)
    && locateFile(app.state.snaps[progCode], r.fileId).length > 0;
  if (viewing) {
    button.disabled = false;
    redrawTree(app);
  } else {
    app.state.touched = false;
    app.render();
  }

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
