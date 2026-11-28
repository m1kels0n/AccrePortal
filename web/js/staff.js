// Login, plus coordinator/admin actions: keyword editing and "Check now".
import { toast, esc, store } from './util.js';
import {
  getProgram, locateFile, applyRequestSection, requestCardsOf, requestFiles, nameKey, REQUEST,
} from './model.js';
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

// ── Requested Documents (staff) ─────────────────────────────
// Requested Documents › <accreditor> › files. Coordinators put files in Drive, then tap ↻ Refresh,
// which rescans only that folder. The accreditor names live in the main program (Access tab).
const NAMES_KEY = 'aaccup:v2:accNames';
// Loaded again when older than this, so an accreditor added to or removed from the Access tab
// shows up within minutes (a removed name must never get its folder made again).
const NAMES_TTL_MS = 2 * 60 * 1000;
let namesPromise = null;

/** The accreditor names: { names, at } (kept with the session token in this tab, for NAMES_TTL_MS). */
function accreditorList() {
  const tok = getSession()?.token;
  const kept = store.get(NAMES_KEY, true);
  if (kept && kept.token === tok && Array.isArray(kept.names) && Date.now() - (kept.at || 0) < NAMES_TTL_MS) {
    return Promise.resolve(kept);
  }
  if (!namesPromise) {
    namesPromise = post(mainProgram(), { action: 'accreditors' }).then((res) => {
      namesPromise = null;
      if (!res.ok || !Array.isArray(res.names)) throw new Error(res.message || 'Could not load the accreditors.');
      const fresh = { token: tok, names: res.names, at: Date.now() };
      store.set(NAMES_KEY, fresh, true);
      return fresh;
    }, (err) => { namesPromise = null; throw err; });
  }
  return namesPromise;
}
const accreditorNames = () => accreditorList().then((l) => l.names);

const onRequestsPage = (app, progCode) => {
  const r = app.state.route;
  return r && r.name === 'workspace' && r.prog === progCode && r.area === REQUEST;
};

/** Put a Requested Documents section from the server into the local copy, then redraw. */
function applyRequestReply(app, progCode, res) {
  const snap = app.state.snaps[progCode];
  if (!snap) return;
  applyRequestSection(snap, res.section || null);
  if (res.hashFrom && snap.hash === res.hashFrom) snap.hash = res.hashTo;
  writeCache(progCode, snap);
  app.reindex();
  // A document open in the viewer stays put: only the tree is redrawn.
  const r = app.state.route;
  const viewing = r && r.name === 'workspace' && r.prog === progCode && r.fileId
    && document.querySelector(`.viewer-frame[data-file="${CSS.escape(r.fileId)}"]`)
    && locateFile(snap, r.fileId).length > 0;
  if (viewing) redrawTree(app);
  else { app.state.touched = false; app.render(); }
}

const reqStatus = (cls, text) => {
  const box = document.querySelector('[data-req-status]');
  if (box) { box.className = 'form-status ' + cls; box.textContent = text; }
};

/** ↻ Refresh: look for new or removed files in Requested Documents only. */
export async function refreshRequests(progCode, button, app) {
  const prog = getProgram(progCode);
  const snap = app.state.snaps[progCode];
  if (!prog || !snap || !isStaff()) return;
  const before = new Set(requestFiles(snap).map((f) => f.id));
  button.disabled = true;
  reqStatus('', 'Looking for new files…');
  const res = await post(prog, { action: 'refreshRequests' });
  button.disabled = false;
  if (!res.ok) {
    reqStatus('error', res.error === 'busy' ? 'The server is busy. Please try again in a few seconds.' : res.message || 'Could not refresh.');
    return;
  }
  applyRequestReply(app, progCode, res);
  const after = requestFiles(app.state.snaps[progCode]).map((f) => f.id);
  const added = after.filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.includes(id)).length;
  if (added) toast(`✓ ${added} new file${added > 1 ? 's' : ''} found.`);
  reqStatus(added || removed ? 'ok' : '',
    added || removed ? '✓ Updated: ' + [added && `${added} new`, removed && `${removed} removed`].filter(Boolean).join(', ') + '.'
      : 'No new files yet. If you just put files in Google Drive, wait until the upload finishes, then tap Refresh again.');
}

// Folder set-ups already tried in this tab (program + missing names), so a failure doesn't loop.
const setupTried = new Set();

/**
 * Opening the "Who asked?" page: load the accreditor names, then create the folder of anyone
 * who has none yet (and Requested Documents itself). Nothing is sent when all folders exist.
 */
export async function prepareRequestsPage(progCode, app) {
  const st = app.state;
  const prog = getProgram(progCode);
  if (!prog || !isStaff()) return;
  const rerender = () => { if (onRequestsPage(app, progCode)) { st.touched = false; app.render(); } };
  // The names could not be loaded: wait for "Try again" (each redraw runs this again, so no loop).
  if (!st.accNames && st.reqSetup[progCode]?.error) return;
  if (!st.accNames || Date.now() - (st.accNamesAt || 0) >= NAMES_TTL_MS) {
    let list;
    try {
      list = await accreditorList();
    } catch (err) {
      if (!st.accNames) {
        st.reqSetup[progCode] = { error: 'Could not load the accreditors. ' + (err.message || '') };
        rerender();
        return;
      }
      list = { names: st.accNames, at: Date.now() }; // keep the names we have; try again later
    }
    const changed = JSON.stringify(list.names) !== JSON.stringify(st.accNames);
    st.accNames = list.names;
    st.accNamesAt = list.at;
    if (changed) { rerender(); return; } // runs this again with the new names
  }
  const snap = st.snaps[progCode];
  if (!snap) return;
  const hasGroup = (snap.groups || []).some((g) => g.code === REQUEST);
  const have = new Set(requestCardsOf(snap).filter((a) => a.owner && a.folderId).map((a) => nameKey(a.owner)));
  const missing = st.accNames.filter((n) => !have.has(nameKey(n)));
  if (hasGroup && !missing.length) return;
  const key = progCode + '|' + hasGroup + '|' + missing.map(nameKey).join(',');
  if (setupTried.has(key)) return;
  setupTried.add(key);
  st.reqSetup[progCode] = { busy: true };
  rerender();
  const res = await post(prog, { action: 'ensureRequestFolders', names: missing });
  if (!getSession()) return;
  if (!res.ok) {
    st.reqSetup[progCode] = { error: res.message || 'Could not set up the folders.' };
    rerender();
    return;
  }
  st.reqSetup[progCode] = {};
  applyRequestReply(app, progCode, res);
  if (res.created?.length) toast(`✓ Folder${res.created.length > 1 ? 's' : ''} ready in Google Drive: ${res.created.join(', ')}`);
}

export function retryRequestSetup(progCode, app) {
  for (const k of [...setupTried]) if (k.startsWith(progCode + '|')) setupTried.delete(k);
  app.state.reqSetup[progCode] = {};
  if (!app.state.accNames) store.remove(NAMES_KEY, true);
  app.state.touched = false;
  app.render();
}

/** ✎ Details: open or close the form; fill in the "Also show to" names the first time. */
export async function toggleRequestForm(button) {
  const form = button.closest('[data-req-scope]')?.querySelector('.req-form');
  if (!form) return;
  form.hidden = !form.hidden;
  if (form.hidden || form.dataset.loaded === '1') return;
  form.dataset.loaded = '1';
  const list = form.querySelector('[data-req-list]');
  const save = form.querySelector('button[type=submit]');
  save.disabled = false; // the description can be saved even if the names don't load
  let names;
  try {
    names = await accreditorNames();
  } catch (err) {
    list.innerHTML = `<span class="error small">${esc(err.message || 'Could not load the accreditors.')}</span>
      <button type="button" class="linklike small" data-action="req-retry">Try again</button>`;
    form.dataset.loaded = '';
    return;
  }
  if (!form.isConnected) return;
  let current = [];
  try { current = JSON.parse(form.dataset.current || '[]'); } catch { current = []; }
  const owner = nameKey(form.dataset.owner);
  const others = names.filter((n) => nameKey(n) !== owner);
  // Names shown earlier that are no longer in the Access tab (renamed or removed): listed so they can be unticked.
  const gone = current.filter((c) => !names.some((n) => nameKey(n) === nameKey(c)));
  const box = (name, note) => `<label class="req-name"><input type="checkbox" name="acc" value="${esc(name)}"
      ${current.some((c) => nameKey(c) === nameKey(name)) ? 'checked' : ''}> <span>${esc(name)}</span>${note ? ` <small class="muted">${note}</small>` : ''}</label>`;
  list.innerHTML = others.length || gone.length
    ? others.map((n) => box(n, '')).join('') + gone.map((n) => box(n, '(not in the Access tab any more)')).join('')
    : '<span class="muted small">No other accreditors.</span>';
  form.dataset.namesOk = '1';
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
  let names;
  if (form.dataset.namesOk === '1') names = [...form.querySelectorAll('input[name=acc]:checked')].map((c) => c.value);
  else { try { names = JSON.parse(form.dataset.current || '[]'); } catch { names = []; } }
  const description = form.querySelector('textarea[name=desc]')?.value || '';
  button.disabled = true;
  status.className = 'kw-status';
  status.textContent = 'Saving…';
  const res = await post(prog, { action: 'saveRequestAccess', fileId, accreditors: names, description });
  button.disabled = false;
  if (!res.ok) {
    status.className = 'kw-status error';
    status.textContent = res.error === 'busy' ? 'The server is busy updating. Please try again in a few seconds.'
      : res.message || 'Could not save.';
    return;
  }
  toast('✓ Details saved.');
  const snap = app.state.snaps[progCode];
  if (!snap) return;
  if (res.section) {
    applyRequestReply(app, progCode, res); // a newly shown name gets the file on their card too
  } else {
    for (const hit of locateFile(snap, fileId)) { hit.file.for = res.accreditors; if (res.description) hit.file.desc = res.description; else delete hit.file.desc; }
    writeCache(progCode, snap);
    redrawTree(app);
  }
  // The viewer bar was not redrawn: update its "For:" line and the form's saved values.
  const file = locateFile(app.state.snaps[progCode], fileId)[0]?.file;
  const line = form.closest('.viewer-bar')?.querySelector('.req-for');
  if (file && line) line.outerHTML = V.requestForLine(file);
  form.dataset.current = JSON.stringify(res.accreditors);
  form.hidden = true;
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
