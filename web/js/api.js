// Data layer: login session, snapshot fetch + per-tab cache, POST calls,
// and a mock backend so the site can be tried before Apps Script exists.
import { CONFIG } from './config.js';
import { store } from './util.js';
import { locateFile, areaKey, REQUEST, SUB_SEP } from './model.js';

const CACHE_PREFIX = 'aaccup:v2:snap:';
const REF_PREFIX = 'aaccup:v2:ref:';   // Reference folders, kept apart (big; a full storage loses only them)
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

/**
 * Requested Documents an accreditor has opened, so the others show as "New". Kept in this
 * browser (only file ids), per accreditor name: on another device they all show as new again.
 */
const SEEN_KEY = 'aaccup:v2:seenReq';
const seenOwner = () => (isMock() ? 'mock:' : '') + String(getSession()?.name || '').toLowerCase();
export const seenRequests = {
  has(fileId) { return ((store.get(SEEN_KEY) || {})[seenOwner()] || []).includes(fileId); },
  add(fileId) {
    const all = store.get(SEEN_KEY) || {};
    const mine = all[seenOwner()] || [];
    if (mine.includes(fileId)) return;
    all[seenOwner()] = [...mine, fileId].slice(-500);
    store.set(SEEN_KEY, all);
  },
};

// ── Snapshot cache (per tab: nothing stays on a shared computer after logout) ──
function cacheKey(code) { return CACHE_PREFIX + (isMock() ? 'mock:' : '') + code; }
function refKey(code) { return REF_PREFIX + (isMock() ? 'mock:' : '') + code; }
const refWritten = {}; // programCode → refLoaded last saved (the Reference copy is rewritten only when it changes)

export function readCache(code) {
  const c = store.get(cacheKey(code), true);
  if (!c || !c.data || !c.data.areas) return null;
  const r = c.data.refLazy ? store.get(refKey(code), true) : null;
  if (r && r.refLoaded && Array.isArray(r.referenceAreas)) {
    c.data.referenceAreas = r.referenceAreas;
    c.data.refLoaded = r.refLoaded;
    refWritten[code] = r.refLoaded;
  }
  return c;
}
/**
 * Save a (prepared) snapshot for this tab. Reference folders loaded on their own (refLazy) go in
 * a separate entry, written only when they change.
 */
export function writeCache(code, data) {
  if (!data.refLazy) {
    store.set(cacheKey(code), { fetchedAt: new Date().toISOString(), data }, true);
    return;
  }
  const { referenceAreas, refLoaded, ...main } = data;
  store.set(cacheKey(code), { fetchedAt: new Date().toISOString(), data: main }, true);
  if (refLoaded && referenceAreas && refWritten[code] !== refLoaded) {
    if (store.set(refKey(code), { refLoaded, referenceAreas }, true)) refWritten[code] = refLoaded;
  }
}
export function removeCache(code) {
  for (const m of ['', 'mock:']) {
    store.remove(CACHE_PREFIX + m + code, true);
    store.remove(REF_PREFIX + m + code, true);
  }
  delete refWritten[code];
}
export function clearCaches() {
  for (const p of CONFIG.programs) removeCache(p.code);
}

// ── Low level fetch with timeout ────────────────────────────
function netError(message, retryable) {
  const e = new Error(message);
  e.code = 'network';
  e.retryable = retryable;
  return e;
}

async function fetchJson(url, options = {}, timeoutMs = CONFIG.requestTimeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw netError('Cannot reach the server. Check your internet connection.', true);
    }
    if (!res.ok) {
      throw netError(`The server is not answering properly right now (error ${res.status}). Please try again in a minute.`,
        res.status >= 500 || res.status === 429);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // e.g. a Google error page instead of JSON ("Service invoked too many times", a sign-in page…)
      throw netError('The server sent an unexpected reply. Please try again in a minute.', true);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** GET with one quiet retry after a short pause (Apps Script sometimes fails once, then works). */
async function getJson(url) {
  try {
    return await fetchJson(url);
  } catch (err) {
    if (!err.retryable) throw err; // a timeout has already waited long enough
    await delay(1500);
    return fetchJson(url);
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
    return getJson(prog.staticUrl + (prog.staticUrl.includes('?') ? '&' : '?') + 't=' + Date.now());
  }
  if (!prog.apiUrl) throw new Error('No apiUrl set in config.js for ' + prog.name);
  const params = new URLSearchParams({ action: 'snapshot' });
  if (s?.token) params.set('token', s.token);
  if (sinceHash) params.set('since', sinceHash);
  // Staff: without the Reference folders, which only the All files page needs (fetchReference).
  // An older backend ignores this and sends them anyway, which still works.
  if (isStaff(s)) params.set('ref', '0');
  const data = await getJson(prog.apiUrl + '?' + params);
  if (data && data.ok === false) {
    if (data.error === 'expired' && endsSession(prog, s)) onExpired();
    throw apiError(data);
  }
  return data;
}

/** Coordinators and admin: a program's Reference folders, { refHash, reference: [...] }. */
export async function fetchReference(prog) {
  const s = getSession();
  if (isMock()) return mockReference(prog, s);
  const params = new URLSearchParams({ action: 'reference' });
  if (s?.token) params.set('token', s.token);
  const data = await getJson(prog.apiUrl + '?' + params);
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
      res = { ok: false, error: 'network', message: err.name === 'AbortError' ? 'The server took too long. Try again.' : err.message || 'Cannot reach the server. Check your connection.' };
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
// Requested Documents ticks saved in mock mode: { fileId: [names] } (the mock JSON's `for` lists are the start).
function mockRequestStore(code) { return store.get('aaccup:mock:req:' + code) || {}; }
const requestSection = (snap) => (snap.sections || []).find((s) => s.code === REQUEST) || null;
function mockSettings(code) { return { ...MOCK_DEFAULT_SETTINGS, ...(store.get('aaccup:mock:settings:' + code) || {}) }; }
// Per-accreditor overrides for one program: [{ name, enabled, areas }] (same shape as Api.gs readOverrides_).
function mockOverrides(code) { return store.get('aaccup:mock:overrides:' + code) || []; }
const sameMockName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
/** The settings that apply to one accreditor (their own if the admin set any, else the program's). */
function mockSettingsFor(code, name) {
  const base = mockSettings(code);
  const ov = mockOverrides(code).find((o) => sameMockName(o.name, name));
  return ov ? { ...base, accreditorEnabled: ov.enabled, accreditorAreas: ov.areas } : base;
}

function mockToken(session) { return 'mock.' + btoa(JSON.stringify(session)); }
function mockReadToken(token) {
  try {
    const s = JSON.parse(atob(String(token).replace(/^mock\./, '')));
    return s && new Date(s.expiresAt) > new Date() ? s : null;
  } catch { return null; }
}

/** Same filtering the Apps Script does for accreditors (see Api.gs viewerArea_ and viewerRequests_). */
function accreditorCopy(snap, settings, name) {
  const allowed = settings.accreditorAreas === 'ALL' ? null : new Set(settings.accreditorAreas.map(areaKey));
  const files = (list) => (list || []).map(({ viewUrl, for: _for, ...f }) => f);
  const mineOnly = (x) => {
    const own = (x.files || []).filter((f) => (f.for || []).some((n) => sameMockName(n, name)));
    if (!own.length) return null;
    const subs = new Set();
    for (const f of own) {
      const parts = f.subfolder ? f.subfolder.split(SUB_SEP) : [];
      for (let i = 1; i <= parts.length; i++) subs.add(parts.slice(0, i).join(SUB_SEP));
    }
    return { code: x.code, name: x.name, files: files(own), subfolders: [...subs].sort() };
  };
  return {
    schema: snap.schema,
    mock: true,
    program: { code: snap.program.code, name: snap.program.name },
    generatedAt: snap.generatedAt,
    hash: snap.hash + '.' + JSON.stringify([settings.accreditorAreas, String(name).toLowerCase()]),
    looseFiles: files(snap.looseFiles),
    sections: (snap.sections || []).filter((x) => x.code === REQUEST || !allowed || allowed.has(areaKey(x.code))).map((x) => (
      x.code === REQUEST ? mineOnly(x) : {
        code: x.code, name: x.name, files: files(x.files),
        subfolders: (x.subfolders || []).map((sf) => (typeof sf === 'string' ? sf : sf.path)),
      })).filter(Boolean),
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
  const req = mockRequestStore(prog.code);
  const reqSec = requestSection(snap);
  // The hash changes with the ticks, so a refresh after saving brings the new lists.
  if (reqSec) {
    for (const f of reqSec.files) { if (req[f.id]) f.for = req[f.id]; f.for = f.for || []; }
    let h = 0;
    for (const ch of JSON.stringify(reqSec.files.map((f) => f.for))) h = (h * 31 + ch.charCodeAt(0)) | 0;
    snap.hash += '.' + (h >>> 0).toString(36);
  }
  if (s.role === 'accreditor') {
    const mine = mockSettingsFor(prog.code, s.name);
    if (!mine.accreditorEnabled) throw apiError({ error: 'noAccess', message: 'This program is not open to accreditors.' });
    return accreditorCopy(snap, mine, s.name);
  }
  const settings = mockSettings(prog.code);
  // Only the admin also gets each accreditor's own settings (see Api.gs adminSettings_).
  snap.settings = s.role === 'admin' ? { ...settings, overrides: mockOverrides(prog.code) } : settings;
  // Staff: Reference folders are loaded separately by the All files page (see Api.gs snapshotFor_ with ref=0).
  const refs = snap.reference || [];
  snap.refHash = mockRefHash(refs);
  snap.refCount = refs.length;
  snap.refLazy = true;
  delete snap.reference;
  return snap;
}

const mockRefHash = (refs) => 'r' + JSON.stringify(refs).length.toString(36);

async function mockReference(prog, session) {
  await delay(400);
  const s = mockReadToken(session?.token);
  if (!s) { onExpired(); throw apiError({ error: 'expired', message: 'Your session expired. Please log in again.' }); }
  if (s.role !== 'coordinator' && s.role !== 'admin') throw apiError({ error: 'forbidden', message: 'Coordinators only.' });
  const snap = await loadMockRaw(prog);
  const kw = mockKeywordStore(prog.code);
  const refs = snap.reference || [];
  for (const r of refs) for (const f of r.files || []) if (kw[f.id]) f.keywords = kw[f.id];
  return { ok: true, refHash: mockRefHash(refs), reference: refs };
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
    const hits = locateFile(snap, payload.fileId);
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
  if (action === 'saveRequestAccess') {
    if (!staff) return { ok: false, error: 'forbidden', message: 'Coordinators only.' };
    if (!Array.isArray(payload.accreditors)) return { ok: false, error: 'invalid', message: 'Bad accreditor list.' };
    const sec = requestSection(await loadMockRaw(prog));
    if (!sec || !sec.files.some((f) => f.id === payload.fileId)) {
      return { ok: false, error: 'notFound', message: 'This file is not in Requested Documents any more. Reload the page.' };
    }
    const names = [];
    for (const raw of payload.accreditors) {
      const n = String(raw ?? '').replace(/\s+/g, ' ').trim();
      if (n && n.length <= 100 && !/^[=+\-@]/.test(n) && !/[,;]/.test(n) && !names.some((x) => sameMockName(x, n))) names.push(n);
    }
    const req = mockRequestStore(prog.code);
    req[payload.fileId] = names; // kept even when empty, so it overrides the mock JSON's starting list
    store.set('aaccup:mock:req:' + prog.code, req);
    return { ok: true, fileId: payload.fileId, accreditors: names };
  }
  if (action === 'accreditors') {
    if (!staff) return { ok: false, error: 'forbidden', message: 'Coordinators only.' };
    if (prog.code !== mainProgram().code) return { ok: false, error: 'notMain', message: 'The accreditor list is kept on the main program.' };
    return { ok: true, names: Object.values(MOCK_PINS).filter((u) => u.role === 'accreditor').map((u) => u.name) };
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
  if (action === 'saveSettings' && payload.accreditor) {
    if (payload.watermark !== undefined) return { ok: false, error: 'invalid', message: 'The watermark is not set per accreditor.' };
    const name = String(payload.accreditor).trim();
    const base = mockSettings(prog.code);
    const rest = mockOverrides(prog.code).filter((o) => !sameMockName(o.name, name));
    const cur = mockOverrides(prog.code).find((o) => sameMockName(o.name, name))
      || { name, enabled: base.accreditorEnabled, areas: base.accreditorAreas };
    const list = payload.reset ? rest : [...rest, {
      name: cur.name,
      enabled: payload.accreditorEnabled === undefined ? cur.enabled : !!payload.accreditorEnabled,
      areas: payload.accreditorAreas === undefined ? cur.areas : payload.accreditorAreas === 'ALL' ? 'ALL' : [...payload.accreditorAreas],
    }];
    store.set('aaccup:mock:overrides:' + prog.code, list);
    return { ok: true, settings: { ...base, overrides: list } };
  }
  if (action === 'saveSettings') {
    const next = mockSettings(prog.code);
    if (payload.accreditorEnabled !== undefined) next.accreditorEnabled = !!payload.accreditorEnabled;
    if (payload.accreditorAreas !== undefined) next.accreditorAreas = payload.accreditorAreas === 'ALL' ? 'ALL' : [...payload.accreditorAreas];
    if (payload.watermark !== undefined) next.watermark = !!payload.watermark;
    store.set('aaccup:mock:settings:' + prog.code, next);
    return { ok: true, settings: { ...next, overrides: mockOverrides(prog.code) } };
  }
  return { ok: false, error: 'invalid', message: 'Unknown action.' };
}
