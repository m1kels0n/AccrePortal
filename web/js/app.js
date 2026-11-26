// Bootstrap: login gate, load snapshots, route, render, wire events.
import { CONFIG } from './config.js';
import { esc, fmtDate, debounce, toast } from './util.js';
import { parseHash, href, replaceQuery, navigate } from './router.js';
import {
  readCache, writeCache, removeCache, clearCaches, fetchSnapshot, isMock, post, getSession, clearSession,
  isStaff, isAdmin, roleLabel, setExpiredHandler, nextHash, lastPlace, mainProgram, hasStoredSession,
} from './api.js';
import { buildIndex, search } from './search.js';
import { getProgram, findArea, findParam, findIndicator, findGroup, areaTitle, indLabel, hrefFor, prepareSnapshot, siblingAreas } from './model.js';
import * as V from './views.js';
import * as S from './staff.js';
import * as A from './admin.js';

const state = {
  snaps: {},        // programCode → snapshot (already filtered by the server for accreditors)
  status: {},       // programCode → { loading, error, offline, noAccess, fetchedAt }
  settings: {},     // programCode → { accreditorEnabled, accreditorAreas, watermark }
  index: null,
  route: null,
  searchLimit: 200,
  navDepth: 0,
  touched: false,   // user typed into a form on the current screen
  openNodes: new Set(),    // tree branches the user opened
  closedNodes: new Set(),  // branches on the current path the user closed
  treeOpen: false,         // tree drawer on small screens
  get watermark() {
    const s = this.settings[mainProgram().code] || Object.values(this.settings)[0];
    return s ? s.watermark !== false : true;
  },
};

const app = { state, render, renderChrome, refresh, reindex, onLogin };
const main = document.getElementById('app');
const input = document.getElementById('searchInput');
const clearBtn = document.getElementById('searchClear');

// ── Setup ───────────────────────────────────────────────────
function applyBrand() {
  const root = document.documentElement.style;
  root.setProperty('--primary', CONFIG.colors.primary);
  root.setProperty('--secondary', CONFIG.colors.secondary);
  root.setProperty('--accent', CONFIG.colors.accent);
  document.getElementById('logos').innerHTML = CONFIG.logos
    .map((l) => `<img src="${esc(l.src)}" alt="${esc(l.alt)}" width="56" height="56">`).join('');
  document.getElementById('schoolName').textContent = CONFIG.school;
  document.getElementById('collegeName').textContent = CONFIG.college;
  document.getElementById('siteTitle').textContent = CONFIG.title;
}

function reindex() { state.index = buildIndex(state.snaps); }

function scopeOf(route) {
  return route.prog && getProgram(route.prog) ? route.prog : 'all';
}

/** Change the URL without a history entry, then render. */
function replaceTo(hash) {
  history.replaceState(null, '', hash);
  render();
}

// ── Chrome: user pill, toolbar, footer ──────────────────────
function renderChrome() {
  const route = state.route || parseHash();
  const session = getSession();
  const loggedIn = !!session && route.name !== 'login';
  const inWs = document.body.classList.contains('is-workspace');

  const pill = document.getElementById('userPill');
  if (loggedIn && !session.guest) {
    const role = roleLabel(session.role);
    const who = session.name && session.name !== role ? `<strong>${esc(session.name)}</strong> · ${esc(role)}` : `<strong>${esc(role)}</strong>`;
    pill.innerHTML = `<span class="who">${who}</span>
      ${isAdmin(session) ? `<a href="${href(['admin', route.prog && getProgram(route.prog) ? route.prog : mainProgram().code])}">Admin panel</a>` : ''}
      <button type="button" class="linklike" data-action="logout">Log out</button>`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }

  document.getElementById('toolbar').hidden = !loggedIn;
  document.getElementById('treeToggle').hidden = !inWs;
  document.getElementById('treeToggle').setAttribute('aria-expanded', String(state.treeOpen));

  // getProgram first: a raw key like #/constructor would otherwise hit Object.prototype.
  const snap = getProgram(route.prog) ? state.snaps[route.prog] : null;
  const areasBtn = document.getElementById('areasBtn');
  // Back to the card page this area was picked from: a Compliance Report / PPP card → that
  // section's page; the Actual Self-Survey Report or Area I … X → the Self-Survey Report page.
  const curArea = snap && route.name === 'workspace' ? findArea(snap, route.area) : null;
  const back = curArea && !curArea.general
    ? (curArea.group ? { href: href([route.prog, curArea.group]), text: '▦ ' + curArea.groupName } : { href: href([route.prog]), text: '▦ Areas' })
    : null;
  areasBtn.hidden = !back;
  if (back) { areasBtn.href = back.href; areasBtn.textContent = back.text; }

  const progPick = document.getElementById('progPick');
  const visibleProgs = CONFIG.programs.filter((p) => state.snaps[p.code]);
  progPick.hidden = !(route.prog && ['program', 'workspace'].includes(route.name) && visibleProgs.length > 1);
  if (!progPick.hidden) {
    document.getElementById('progSelect').innerHTML = visibleProgs.map((p) =>
      `<option value="${esc(p.code)}" ${p.code === route.prog ? 'selected' : ''}>${esc(V.programName(p, state.snaps[p.code]))}</option>`).join('');
  }
  const areaPick = document.getElementById('areaPick');
  const siblings = siblingAreas(snap, curArea);
  areaPick.hidden = siblings.length < 2;
  if (!areaPick.hidden) {
    document.getElementById('areaSelect').innerHTML = siblings.map((a) =>
      `<option value="${esc(a.code)}" ${a.code === route.area ? 'selected' : ''}>${esc(a.group ? areaTitle({ ...a, groupName: '' }) : areaTitle(a))}</option>`).join('');
  }
  document.getElementById('searchForm').hidden = route.name === 'admin';
  input.placeholder = route.prog && snap ? `Search ${V.programName(getProgram(route.prog), snap)}…` : 'Search documents, keywords, indicators…';

  const updated = loggedIn ? CONFIG.programs
    .filter((p) => state.snaps[p.code]?.generatedAt)
    .map((p) => `${esc(V.programName(p, state.snaps[p.code]))}: ${esc(fmtDate(state.snaps[p.code].generatedAt, true))}`) : [];
  document.getElementById('updated').innerHTML =
    (updated.length ? 'Last updated — ' + updated.join(' · ') : '') +
    (isMock() ? ' <span class="mock-tag">MOCK DATA</span>' : '');

  const offline = loggedIn ? CONFIG.programs.filter((p) => state.status[p.code]?.offline) : [];
  const notice = document.getElementById('notice');
  if (offline.length) {
    // The folder link only exists in staff snapshots (never in the public config).
    const links = isStaff() ? offline.filter((p) => state.snaps[p.code]?.program?.rootFolderUrl)
      .map((p) => `<a href="${esc(state.snaps[p.code].program.rootFolderUrl)}" target="_blank" rel="noopener">Open ${esc(p.name)} folder in Drive</a>`) : [];
    notice.innerHTML = 'Showing a saved copy — live data is unavailable right now.' + (links.length ? ' ' + links.join(' · ') : '');
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}

// ── Render ──────────────────────────────────────────────────
function render(background = false) {
  const route = parseHash();
  const session = getSession();

  // Login gate: every screen needs a session; deep links continue after login.
  if (!session && route.name !== 'login') {
    if (location.hash && location.hash !== '#/' && location.hash !== '#') nextHash.set(location.hash);
    replaceTo('#/login');
    return;
  }
  if (session && route.name === 'login') { replaceTo('#/'); return; }
  if (route.name === 'admin' && !isAdmin(session)) { replaceTo('#/'); return; }

  state.route = route;
  if (document.activeElement !== input) input.value = route.q;
  clearBtn.hidden = !input.value;

  // Background data updates must not wipe a form the user has started filling in,
  // or reload an open document.
  if (background) {
    const viewing = route.fileId && route.q.trim().length < 2 && main.querySelector(`.viewer-frame[data-file="${CSS.escape(route.fileId)}"]`);
    if (state.touched || viewing) { renderChrome(); return; }
  }
  state.touched = false;

  const searching = route.q.trim().length >= 2 && ['home', 'program', 'workspace'].includes(route.name);
  const searchHtml = searching
    ? V.renderSearch(state, route, search(state.index, route.q, scopeOf(route), state.searchLimit), scopeOf(route)) : '';

  const oldScroll = document.getElementById('treeScroll');
  const sameArea = route.name === 'workspace' && main.querySelector(`.workspace[data-area="${CSS.escape(route.prog + '/' + route.area)}"]`);
  const treeTop = sameArea && oldScroll ? oldScroll.scrollTop : 0;

  let html;
  let workspace = false;
  switch (route.name) {
    case 'login': html = V.renderLogin(); break;
    case 'home': html = searching ? searchHtml : V.renderHome(state); break;
    case 'program': html = searching ? searchHtml : V.renderProgram(state, route); break;
    case 'workspace': ({ html, workspace } = V.renderWorkspace(state, route, searchHtml)); break;
    case 'admin': html = A.renderAdmin(state, route); break;
    default: html = V.notFound();
  }
  main.innerHTML = html;
  // Removing a focused field (e.g. the PIN box) fires a late `change` that would mark the new
  // screen as "touched" and block background redraws, so reset the flag after the swap too.
  state.touched = false;
  main.classList.toggle('wrap', !workspace);
  document.body.classList.toggle('is-workspace', workspace);
  document.body.classList.toggle('is-login', route.name === 'login');
  document.body.classList.toggle('tree-open', workspace && state.treeOpen);
  // A document is open: the tree tucks away into a drawer so the document gets the full width.
  document.body.classList.toggle('has-doc', workspace && !!route.fileId && !searching);
  document.body.classList.toggle('role-viewer', !!session && !isStaff(session));

  if (workspace) {
    const scroller = document.getElementById('treeScroll');
    if (sameArea) scroller.scrollTop = treeTop;
    else scroller.querySelector('.tn-link.active')?.scrollIntoView({ block: 'center' });
    const prog = getProgram(route.prog);
    if (prog) lastPlace.set({ prog: prog.code, area: route.area });
    if (route.fileId && !searching) setupViewer();
  }
  if (route.name === 'admin') A.loadAdminData(route.prog);
  if (route.name === 'login') document.getElementById('pin')?.focus();
  setTitle(route, searching);
  renderChrome();
}

function setTitle(route, searching) {
  const base = 'TUP-CIE Accreditation 2026';
  if (route.name === 'login') { document.title = 'Log in · ' + base; return; }
  if (searching) { document.title = `Search: ${route.q} · ${base}`; return; }
  const snap = getProgram(route.prog) ? state.snaps[route.prog] : null;
  const area = snap && findArea(snap, route.area);
  const ind = area && findIndicator(findParam(area, route.param), route.ind);
  const group = !area && snap && findGroup(snap, route.area);
  const bits = [ind ? indLabel(ind) : route.ind, area ? areaTitle(area) : group ? group.name : null, snap?.program?.name].filter(Boolean);
  document.title = (bits.length ? bits.join(' · ') + ' · ' : '') + base;
}

function setupViewer() {
  const frameBox = main.querySelector('.viewer-frame');
  const wm = frameBox?.querySelector('.watermark');
  if (wm) {
    const date = new Intl.DateTimeFormat('en-PH', { timeZone: CONFIG.timezone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
    // Each accreditor has their own PIN, so the watermark carries their name.
    const who = getSession()?.name;
    const name = who && who !== 'Accreditor' && who !== 'Guest' ? who : 'Accreditor view';
    wm.style.backgroundImage = V.watermarkImage(`AACCUP · ${name} · ${date}`);
  }
  const frame = frameBox?.querySelector('iframe');
  if (!frame) return;
  const loading = main.querySelector('.viewer-loading');
  const slow = main.querySelector('.viewer-slow');
  const timer = setTimeout(() => { if (slow) slow.hidden = false; }, 15000);
  frame.addEventListener('load', () => { clearTimeout(timer); loading?.remove(); }, { once: true });
}

function setTreeOpen(open) {
  state.treeOpen = open;
  document.body.classList.toggle('tree-open', open && document.body.classList.contains('is-workspace'));
  document.getElementById('treeToggle').setAttribute('aria-expanded', String(open));
  if (open) {
    document.querySelector('#treeScroll .tn-link.active')?.scrollIntoView({ block: 'center' });
  }
}

// ── Data refresh ────────────────────────────────────────────
async function refresh(code, force = false) {
  const prog = getProgram(code);
  if (!prog || !getSession()) return;
  // A reply that arrives after logout or a new login belongs to the old session: drop it.
  const tok = getSession().token;
  const stale = () => !getSession() || getSession().token !== tok;
  const had = state.snaps[code];
  const statusKey = (s) => (s?.loading ? 'loading' : s?.noAccess ? 'noAccess' : s?.error ? 'error' : s?.fromCache ? 'cache' : 'ok');
  const before = statusKey(state.status[code]);
  const settingsBefore = JSON.stringify(state.settings[code] || null);
  let changed = false;
  if (!had) state.status[code] = { loading: true };
  try {
    const data = await fetchSnapshot(prog, force ? null : had?.hash);
    if (stale()) return;
    if (data && data.unchanged && had) {
      if (data.generatedAt) had.generatedAt = data.generatedAt;
      if (data.settings) had.settings = data.settings;
      writeCache(code, had);
    } else if (data && Array.isArray(data.areas)) {
      changed = !had || had.hash !== data.hash || !data.hash || isMock();
      state.snaps[code] = prepareSnapshot(data);
      writeCache(code, data);
      reindex();
    } else {
      throw new Error('Unexpected response from the server.');
    }
    if (data.settings) state.settings[code] = data.settings;
    state.status[code] = { ok: true, fetchedAt: Date.now() };
  } catch (err) {
    if (stale()) return; // old session, or sessionExpired() already logged out
    if (err.code === 'noAccess') {
      changed = !!state.snaps[code] || !!state.settings[code];
      delete state.snaps[code];
      delete state.settings[code];
      removeCache(code);
      reindex();
      state.status[code] = { noAccess: true, fetchedAt: Date.now() };
    } else {
      console.warn('Snapshot refresh failed for', code, err);
      state.status[code] = {
        error: err.name === 'AbortError' ? 'The server took too long to respond.' : (err.message || 'Network error'),
        code: err.code,
        offline: !!state.snaps[code],
        fetchedAt: Date.now(),
      };
    }
  }
  if (JSON.stringify(state.settings[code] || null) !== settingsBefore) changed = true;
  if (changed || before !== statusKey(state.status[code])) render(true);
  else renderChrome();
}

function refreshAll(force = false) {
  if (!getSession()) return Promise.resolve();
  return Promise.all(CONFIG.programs.map((p) => refresh(p.code, force)));
}

function staleMs() {
  const times = CONFIG.programs.map((p) => state.status[p.code]?.fetchedAt || 0);
  return Date.now() - Math.min(...times);
}

function loadFromCache() {
  for (const p of CONFIG.programs) {
    const cached = readCache(p.code);
    if (cached) {
      state.snaps[p.code] = prepareSnapshot(cached.data);
      if (cached.data.settings) state.settings[p.code] = cached.data.settings;
      state.status[p.code] = { fromCache: true };
    } else {
      state.status[p.code] = { loading: true };
    }
  }
  reindex();
}

// ── Session changes ─────────────────────────────────────────
function resetData() {
  state.snaps = {};
  state.status = {};
  state.settings = {};
  state.openNodes.clear();
  state.closedNodes.clear();
  state.treeOpen = false;
  reindex();
}

function onLogin() {
  resetData();
  loadFromCache();
  refreshAll();
  const next = nextHash.get();
  nextHash.clear();
  navigate(next && !next.startsWith('#/login') ? next : '#/');
}

function logout() {
  post(mainProgram(), { action: 'logout' });
  clearSession();
  clearCaches();
  nextHash.clear();
  resetData();
  toast('Logged out.');
  navigate('#/login');
}

function sessionExpired() {
  // Not getSession(): it already drops a session that just ran out, which is the case to handle here.
  if (!hasStoredSession() || CONFIG.requireLogin === false) return;
  if (location.hash && !location.hash.startsWith('#/login')) nextHash.set(location.hash);
  clearSession();
  clearCaches();
  resetData();
  toast('Your session expired. Please log in again.', 'error');
  navigate('#/login');
}
setExpiredHandler(sessionExpired);

// ── Events ──────────────────────────────────────────────────
const onSearch = debounce(() => {
  state.searchLimit = 200;
  replaceQuery(input.value);
  render();
}, 150);

input.addEventListener('input', () => { clearBtn.hidden = !input.value; onSearch(); });
input.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSearch(); });
document.getElementById('searchForm').addEventListener('submit', (e) => { e.preventDefault(); input.blur(); });
clearBtn.addEventListener('click', () => { clearSearch(); input.focus(); });

function clearSearch() {
  input.value = '';
  clearBtn.hidden = true;
  replaceQuery('');
  render();
}

window.addEventListener('hashchange', () => {
  state.navDepth++;
  const r = parseHash();
  // Navigating to a node opens it again even if it was closed by hand earlier.
  if (r.prog && r.area && r.param) {
    state.closedNodes.delete(V.nodeKey(r.prog, r.area, r.param));
    if (r.ind) state.closedNodes.delete(V.nodeKey(r.prog, r.area, r.param, r.ind));
    // Subfolders inside the indicator too, so the picked document is visible in the tree.
    if (r.ind && r.fileId) {
      const sub = V.nodeKey(r.prog, r.area, r.param, r.ind) + '/~';
      [...state.closedNodes].forEach((k) => { if (k.startsWith(sub)) state.closedNodes.delete(k); });
    }
  }
  if (r.fileId) {
    state.treeOpen = false; // close the drawer on phones once a document is picked
    document.body.classList.add('tree-lock'); // desktop: shrink the tree back even though the mouse is still on it
    // Once the shrink finishes, unlock if the pointer is no longer on the tree (e.g. it is over the
    // document iframe, which sends no pointermove here), so hovering the tree again widens it.
    setTimeout(() => {
      if (!document.querySelector('.tree-pane:hover')) document.body.classList.remove('tree-lock');
    }, 250);
  }
  render();
  if (!document.body.classList.contains('is-workspace')) window.scrollTo(0, 0);
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'clear-search') {
    clearSearch();
  } else if (action === 'show-more') {
    state.searchLimit += 200;
    render();
  } else if (action === 'kw-toggle') {
    const form = el.closest('[data-kw-scope], .file-item')?.querySelector('.kw-form');
    if (form) { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); }
  } else if (action === 'logout') {
    logout();
  } else if (action === 'check-now') {
    S.checkNow(el.dataset.prog, el, app);
  } else if (action === 'admin-refresh' || action === 'admin-rebuild') {
    A.adminAction(action === 'admin-rebuild' ? 'rebuild' : 'refresh', el.dataset.prog, el, app);
  } else if (action === 'tree-toggle') {
    setTreeOpen(!state.treeOpen);
  } else if (action === 'tree-close') {
    setTreeOpen(false);
  } else if (action === 'tree-expand' || action === 'tree-collapse') {
    const open = action === 'tree-expand';
    document.querySelectorAll('#tree details[data-node]').forEach((d) => { d.open = open; });
  } else if (action === 'areas-all' || action === 'areas-none') {
    el.closest('form')?.querySelectorAll('input[name=area]').forEach((c) => { c.checked = action === 'areas-all'; });
    state.touched = true;
  }
});

// Remember which tree branches are open (toggle events don't bubble, so listen in the capture phase).
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.node) return;
  if (d.open) { state.openNodes.add(d.dataset.node); state.closedNodes.delete(d.dataset.node); }
  else { state.openNodes.delete(d.dataset.node); state.closedNodes.add(d.dataset.node); }
}, true);

document.addEventListener('change', (e) => {
  if (e.target.id === 'progSelect') navigate(href([e.target.value]));
  if (e.target.id === 'areaSelect') {
    const snap = getProgram(state.route?.prog) ? state.snaps[state.route.prog] : null;
    const area = snap && findArea(snap, e.target.value);
    if (area) navigate(hrefFor(state.route.prog, area));
  }
});

main.addEventListener('input', (e) => {
  if (e.target.name === 'pin') {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== e.target.value) e.target.value = digits;
    if (digits.length === 6) e.target.form.requestSubmit();
    return;
  }
  state.touched = true;
});
main.addEventListener('change', (e) => { if (e.target.name !== 'pin') state.touched = true; });

document.addEventListener('submit', (e) => {
  const form = e.target;
  const handlers = {
    login: () => S.handleLogin(form, app),
    kw: () => S.handleSaveKeywords(form, app),
    watermark: () => A.saveWatermark(form, app),
    access: () => A.saveAccess(form, app),
  };
  const h = handlers[form.dataset.form];
  if (h) { e.preventDefault(); h(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.treeOpen) setTreeOpen(false);
});

// Accreditors: no right-click menu and no dragging (stops the easy "copy link" routes).
document.addEventListener('contextmenu', (e) => {
  if (getSession() && !isStaff() && !e.target.closest('input, textarea')) e.preventDefault();
});
document.addEventListener('dragstart', (e) => {
  if (getSession() && !isStaff()) e.preventDefault();
});

// The tree stays small after a file is picked until the mouse leaves it; hovering it again widens it.
document.addEventListener('pointermove', (e) => {
  if (document.body.classList.contains('tree-lock') && !e.target.closest?.('.tree-pane')) {
    document.body.classList.remove('tree-lock');
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && getSession() && staleMs() > CONFIG.refreshMinutes * 60000) refreshAll();
});
setInterval(() => { if (!document.hidden && getSession()) refreshAll(); }, CONFIG.refreshMinutes * 60000);

// ── Start ───────────────────────────────────────────────────
function start() {
  applyBrand();
  if (getSession()) {
    loadFromCache();
    render();
    refreshAll();
  } else {
    reindex();
    render();
  }
}

start();

// Handy for debugging in the browser console.
window.AACCUP = { state, refreshAll, getSession };
