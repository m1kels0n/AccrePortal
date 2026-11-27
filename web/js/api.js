// Data layer: login session, snapshot fetch + per-tab cache, POST calls,
// and a mock backend so the site can be tried before Apps Script exists.
import { CONFIG } from './config.js';
import { store } from './util.js';
import { locateFile, areaKey } from './model.js';

const CACHE_PREFIX = 'aaccup:v2:snap:';
const SESSION_KEY = 'aaccup:v2:session';
const NEXT_KEY = 'aaccup:v2:next';
const LAST_KEY = 'aaccup:v2:last';

export function isMock() {
  const p = new URLSearchParams(location.search).get('mock');
  if (p === '1' || p === 'true') return true;
  if (p === '0' || p === 'false') return false;
  return CONFIG.mode === 'mock';
}

/** The first program's backend holds the PINs and handles logins. */
export const mainProgram = () => CONFIG.programs[0];

let onExpired = () => {};
/** Called when the server says the session token is no longer valid. */
export function setExpiredHandler(fn) { onExpired = fn; }

// ── Session (token only, never the PIN; per browser tab) ────
const GUEST = Object.freeze({ role: 'accreditor', name: 'Guest', token: null, guest: true });

export function getSession() {
  if (CONFIG.requireLogin === false) return GUEST;
  const s = store.get(SESSION_KEY, true);
  if (!s) return null;
  if (s.expiresAt && new Date(s.expiresAt) < new Date()) { clearSession(); return null; }
  return s;
}
export function setSession(session) { store.set(SESSION_KEY, session, true); }
export function clearSession() { store.remove(SESSION_KEY, true); }
/** The stored session even after it has run out (getSession() drops those). */
function storedSession() { return CONFIG.requireLogin === false ? GUEST : store.get(SESSION_KEY, true); }
export const hasStoredSession = () => !!storedSession();

export const isStaff = (s = getSession()) => !!s && (s.role === 'coordinator' || s.role === 'admin');
export const isAdmin = (s = getSession()) => !!s && s.role === 'admin';
export const roleLabel = (role) => ({ accreditor: 'Accreditor', coordinator: 'Coordinator', admin: 'Admin' }[role] || role);

/** Where to go after logging in (the deep link someone opened before logging in). */
export const nextHash = {
  get: () => store.get(NEXT_KEY, true),
  set: (h) => store.set(NEXT_KEY, h, true),
  clear: () => store.remove(NEXT_KEY, true),
};

/** Last program + area opened, for "Continue where you left off". */
export const lastPlace = {
  get: () => store.get(LAST_KEY),
  set: (v) => store.set(LAST_KEY, v),
};

// ── Snapshot cache (per tab: nothing stays on a shared computer after logout) ──
function cacheKey(code) { return CACHE_PREFIX + (isMock() ? 'mock:' : '') + code; }
export function readCache(code) {
  const c = store.get(cacheKey(code), true);
  return c && c.data && c.data.areas ? c : null;
}
export function writeCache(code, data) {
  store.set(cacheKey(code), { fetchedAt: new Date().toISOString(), data }, true);
}
export function removeCache(code) {
  store.remove(CACHE_PREFIX + code, true);
  store.remove(CACHE_PREFIX + 'mock:' + code, true);
}
export function clearCaches() {
  for (const p of CONFIG.programs) {
    store.remove(CACHE_PREFIX + p.code, true);
    store.remove(CACHE_PREFIX + 'mock:' + p.code, true);
  }
}

// ── Low level fetch with timeout ────────────────────────────
async function fetchJson(url, options = {}, timeoutMs = CONFIG.requestTimeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function apiError(data) {
  const e = new Error(data.message || data.error || 'Server error');
  e.code = data.error;
  return e;
}

/**
 * Should an 'expired' answer end the whole session? Only if the token sent is still the
 * current one (not a reply from before a logout/login), and only when the main program
 * said so or the session really ran out. A linked program alone just shows an error.
 */
function endsSession(prog, sent) {
  const cur = storedSession();
  if (!cur || cur.token !== sent?.token) return false;
  return prog.code === mainProgram().code || (!!sent.expiresAt && new Date(sent.expiresAt) <= new Date());
}

/**
 * Fetch a program's snapshot for the logged-in user. Returns either a full snapshot
 * or { unchanged: true, generatedAt, settings } when `sinceHash` still matches.
 * Throws an Error with .code 'expired', 'notLinked' or 'noAccess' when relevant.
 */
export async function fetchSnapshot(prog, sinceHash) {
  const s = getSession();
  if (isMock()) return mockSnapshot(prog, s);
  if (prog.source === 'static') {
    return fetchJson(prog.staticUrl + (prog.staticUrl.includes('?') ? '&' : '?') + 't=' + Date.now());
  }
  if (!prog.apiUrl) throw new Error('No apiUrl set in config.js for ' + prog.name);
  const params = new URLSearchParams({ action: 'snapshot' });
  if (s?.token) params.set('token', s.token);
  if (sinceHash) params.set('since', sinceHash);
  const data = await fetchJson(prog.apiUrl + '?' + params);
  if (data && data.ok === false) {
    if (data.error === 'expired' && endsSession(prog, s)) onExpired();
    throw apiError(data);
  }
  return data;
}

/** POST an action to a program's Apps Script (text/plain avoids a CORS preflight). The token is added automatically. */
export async function post(prog, payload, opts = {}) {
  const s = getSession();
  const body = s?.token && payload.action !== 'login' ? { token: s.token, ...payload } : payload;
  let res;
  if (isMock()) {
    res = await mockPost(prog, body);
  } else if (prog.source !== 'api' || !prog.apiUrl) {
    res = { ok: false, error: 'offline', message: 'This needs the live backend (apiUrl in config.js).' };
  } else {
    try {
      res = await fetchJson(prog.apiUrl, { method: 'POST', body: JSON.stringify(body) }, opts.timeoutMs);
    } catch (err) {
      res = { ok: false, error: 'network', message: err.name === 'AbortError' ? 'The server took too long. Try again.' : 'Cannot reach the server. Check your connection.' };
    }
  }
  if (res && res.error === 'expired' && payload.action !== 'login' && endsSession(prog, s)) onExpired();
  return res;
}

export function login(pin) {
  return post(mainProgram(), { action: 'login', pin });
}

export function cleanKeywords(input) {
  const seen = new Set();
  const out = [];
  for (const raw of String(input || '').split(/[,;\n]/)) {
    const k = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
    const key = k.toLowerCase();
    if (k && !seen.has(key)) { seen.add(key); out.push(k); }
    if (out.length >= 20) break;
  }
  return out;
}

// ── Mock backend ────────────────────────────────────────────
// Mock PINs: 111111 = accreditor Dr. Reyes, 333333 = accreditor Dr. Cruz
// (one PIN per accreditor), 222222 = coordinators (shared), 000000 = admin.
const MOCK_PINS = {
  111111: { role: 'accreditor', name: 'Dr. Reyes' },
  333333: { role: 'accreditor', name: 'Dr. Cruz' },
  222222: { role: 'coordinator', name: 'Coordinator' },
  '000000': { role: 'admin', name: 'Admin' },
};
const MOCK_DEFAULT_SETTINGS = { accreditorEnabled: true, accreditorAreas: 'ALL', watermark: true };
const mockRaw = {};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadMockRaw(prog) {
  if (!mockRaw[prog.code]) mockRaw[prog.code] = await fetchJson(prog.mockUrl + '?t=' + Date.now());
  return structuredClone(mockRaw[prog.code]);
}

function mockKeywordStore(code) { return store.get('aaccup:mock:kw:' + code) || {}; }
function mockSettings(code) { return { ...MOCK_DEFAULT_SETTINGS, ...(store.get('aaccup:mock:settings:' + code) || {}) }; }

function mockToken(session) { return 'mock.' + btoa(JSON.stringify(session)); }
function mockReadToken(token) {
  try {
    const s = JSON.parse(atob(String(token).replace(/^mock\./, '')));
    return s && new Date(s.expiresAt) > new Date() ? s : null;
  } catch { return null; }
}

/** Same filtering the Apps Script does for accreditors (see Api.gs viewerArea_). */
function accreditorCopy(snap, settings) {
  const allowed = settings.accreditorAreas === 'ALL' ? null : new Set(settings.accreditorAreas.map(areaKey));
  const files = (list) => (list || []).map(({ viewUrl, ...f }) => f);
  return {
    schema: snap.schema,
    mock: true,
    program: { code: snap.program.code, name: snap.program.name },
    generatedAt: snap.generatedAt,
    hash: snap.hash + '.' + JSON.stringify(settings.accreditorAreas),
    looseFiles: files(snap.looseFiles),
    sections: (snap.sections || []).filter((x) => !allowed || allowed.has(areaKey(x.code))).map((x) => ({
      code: x.code, name: x.name, files: files(x.files),
      subfolders: (x.subfolders || []).map((sf) => (typeof sf === 'string' ? sf : sf.path)),
    })),
    areas: snap.areas.filter((a) => !allowed || allowed.has(areaKey(a.code))).map((a) => ({
      code: a.code, name: a.name, looseFiles: files(a.looseFiles),
      parameters: a.parameters.map((p) => ({
        code: p.code, name: p.name, looseFiles: files(p.looseFiles),
        indicators: p.indicators.map((i) => ({
          code: i.code, type: i.type, text: i.text,
          files: files(i.files),
          subfolders: (i.subfolders || []).map((s) => (typeof s === 'string' ? s : s.path)),
        })),
      })),
    })),
    settings: { watermark: settings.watermark },
  };
}

async function mockSnapshot(prog, session) {
  await delay(250);
  const s = session?.guest ? session : mockReadToken(session?.token);
  if (!s) { onExpired(); throw apiError({ error: 'expired', message: 'Your session expired. Please log in again.' }); }
  const snap = await loadMockRaw(prog);
  const kw = mockKeywordStore(prog.code);
  for (const fileId of Object.keys(kw)) {
    for (const hit of locateFile(snap, fileId)) hit.file.keywords = kw[fileId];
  }
  const settings = mockSettings(prog.code);
  if (s.role === 'accreditor') {
    if (!settings.accreditorEnabled) throw apiError({ error: 'noAccess', message: 'This program is not open to accreditors.' });
    return accreditorCopy(snap, settings);
  }
  if (s.role !== 'admin') delete snap.reference; // Reference folders: admin only (see Api.gs snapshotFor_)
  snap.settings = settings;
  return snap;
}

async function mockPost(prog, payload) {
  await delay(350);
  const action = payload.action;
  if (action === 'login') {
    if (prog.code !== mainProgram().code) return { ok: false, error: 'notMain', message: 'Logins go through the main program.' };
    const user = MOCK_PINS[String(payload.pin || '').trim()];
    if (!user) return { ok: false, error: 'badPin', message: 'Wrong PIN. Please try again.' };
    const session = { ...user, expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString() };
    return { ok: true, ...session, token: mockToken(session) };
  }
  if (action === 'logout') return { ok: true };
  const s = mockReadToken(payload.token);
  if (!s) return { ok: false, error: 'expired', message: 'Your session expired. Please log in again.' };
  const staff = s.role === 'coordinator' || s.role === 'admin';

  if (action === 'saveKeywords') {
    if (!staff) return { ok: false, error: 'forbidden', message: 'Coordinators only.' };
    const snap = await loadMockRaw(prog);
    const hits = locateFile(snap, payload.fileId).filter((h) => s.role === 'admin' || !h.reference);
    if (!hits.length) return { ok: false, error: 'notFound', message: 'File not found. It may have been moved or deleted.' };
    const keywords = cleanKeywords(payload.keywords);
    const kw = mockKeywordStore(prog.code);
    if (keywords.length) kw[payload.fileId] = keywords; else delete kw[payload.fileId];
    store.set('aaccup:mock:kw:' + prog.code, kw);
    return { ok: true, fileId: payload.fileId, keywords, updatedAt: new Date().toISOString() };
  }
  if (action === 'checkNow') {
    if (!staff) return { ok: false, error: 'forbidden', message: 'Coordinators only.' };
    await delay(1200);
    return { ok: true, generatedAt: new Date().toISOString(), changed: false, ms: 1200 };
  }
  if (s.role !== 'admin') return { ok: false, error: 'forbidden', message: 'Admin only.' };
  if (action === 'refresh' || action === 'rebuildStructure') {
    await delay(900);
    return { ok: true, generatedAt: new Date().toISOString(), ms: 4200 };
  }
  if (action === 'issues') {
    const all = await fetchJson('data/mock-issues.json?t=' + Date.now());
    const mine = all[prog.code] || { items: [] };
    return { ok: true, items: mine.items, lastScan: new Date(Date.now() - 120000).toISOString(), lastScanMs: 4200, triggerActive: true };
  }
  if (action === 'saveSettings') {
    const next = mockSettings(prog.code);
    if (payload.accreditorEnabled !== undefined) next.accreditorEnabled = !!payload.accreditorEnabled;
    if (payload.accreditorAreas !== undefined) next.accreditorAreas = payload.accreditorAreas === 'ALL' ? 'ALL' : [...payload.accreditorAreas];
    if (payload.watermark !== undefined) next.watermark = !!payload.watermark;
    store.set('aaccup:mock:settings:' + prog.code, next);
    return { ok: true, settings: next };
  }
  return { ok: false, error: 'invalid', message: 'Unknown action.' };
}
