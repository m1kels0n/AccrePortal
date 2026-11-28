// Data layer: login session, snapshot fetch + per-tab cache, POST calls,
// and a mock backend so the site can be tried before Apps Script exists.
import { CONFIG } from './config.js';
import { store } from './util.js';
import { locateFile, areaKey, REQUEST, REQUEST_NAME, SUB_SEP, nameKey } from './model.js';

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

/**
 * The token to send. A renewed accreditor token goes in `auth`, and `token` stays the one from
 * the login: the rest of the site compares `token` to tell one login from another (and to show
 * the welcome pop-up once per login), so renewing must not change it.
 */
const authToken = (s) => s?.auth || s?.token;

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
  if (s?.token) params.set('token', authToken(s));
  if (sinceHash) params.set('since', sinceHash);
  // Staff: without the Reference folders, which only the All files page needs (fetchReference).
  // An older backend ignores this and sends them anyway, which still works.
  if (isStaff(s)) params.set('ref', '0');
  const data = await getJson(prog.apiUrl + '?' + params);
  if (data && data.ok === false) {
    if (data.error === 'expired' && endsSession(prog, s)) onExpired(data.message);
    throw apiError(data);
  }
  return data;
}

/** Coordinators and admin: a program's Reference folders, { refHash, reference: [...] }. */
export async function fetchReference(prog) {
  const s = getSession();
  if (isMock()) return mockReference(prog, s);
  const params = new URLSearchParams({ action: 'reference' });
  if (s?.token) params.set('token', authToken(s));
  const data = await getJson(prog.apiUrl + '?' + params);
  if (data && data.ok === false) {
    if (data.error === 'expired' && endsSession(prog, s)) onExpired(data.message);
    throw apiError(data);
  }
  return data;
}

/** POST an action to a program's Apps Script (text/plain avoids a CORS preflight). The token is added automatically. */
export async function post(prog, payload, opts = {}) {
  const s = getSession();
  const body = s?.token && payload.action !== 'login' ? { token: authToken(s), ...payload } : payload;
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
  if (res && res.error === 'expired' && payload.action !== 'login' && endsSession(prog, s)) onExpired(res.message);
  return res;
}

/**
 * The server's expiresAt is by the server's clock. When it also says how many seconds are left
 * (expiresIn), turn that into a time by this device's clock, so a phone whose clock is off still
 * keeps the session the right length. An older backend sends only expiresAt: kept as it is.
 */
function localExpiry(res) {
  const secs = Number(res && res.expiresIn);
  if (!res || !res.ok || !res.expiresAt || !(secs > 0)) return res;
  return { ...res, expiresAt: new Date(Date.now() + secs * 1000).toISOString() };
}

export function login(pin) {
  return post(mainProgram(), { action: 'login', pin }).then(localExpiry);
}

// ── Accreditor session renewal ──────────────────────────────
// An accreditor's token lasts 2 hours (ACC_TOKEN_SEC in Security.gs), because only the main program
// can see that someone was removed from the Access tab. Before it runs out, the main program swaps
// it for a new one (after checking the Access tab), up to 12 hours from login. Checked every
// minute, when the tab is shown again and when the connection comes back.
const RENEW_BEFORE_MS = 45 * 60000; // renew when less than this is left
const RENEW_RETRY_MS = 60000;       // after a network or server error, wait this long
const RENEW_GAP_MS = 10 * 60000;    // never renew again sooner than this after a renewal
let renewing = null;                // one renewal at a time
let renewRetryAt = 0;

const renewDue = (s) => !!s && !s.guest && s.role === 'accreditor' && !s.noRenew && !!s.expiresAt
  && new Date(s.expiresAt) - Date.now() < RENEW_BEFORE_MS
  && !(Date.now() - (s.renewedAt || 0) < RENEW_GAP_MS); // a safety net, so a renewal can never repeat every minute

/** Renew the accreditor's token if it is due (does nothing otherwise). Never throws. */
export function renewSession() {
  if (renewing) return renewing;
  const s = getSession();
  if (!renewDue(s) || Date.now() < renewRetryAt) return Promise.resolve();
  const prog = mainProgram();
  if (!isMock() && (prog.source !== 'api' || !prog.apiUrl)) return Promise.resolve();
  renewing = post(prog, { action: 'renew' }).then(localExpiry).then((res) => {
    // Logged out, or someone else logged in, while it was on its way: the reply is not for them.
    const cur = storedSession();
    if (!cur || cur.token !== s.token) return;
    if (res && res.ok && res.token && res.expiresAt) {
      // No later than before (12 hours from login are up): keep it until it runs out.
      const last = res.final || !(new Date(res.expiresAt) > new Date(cur.expiresAt));
      setSession({ ...cur, auth: res.token, expiresAt: res.expiresAt, renewedAt: Date.now(), ...(last ? { noRenew: true } : {}) });
      return;
    }
    const err = res && res.error;
    if (err === 'expired') return; // post() has already ended the session (onExpired)
    if (!err || err === 'invalid' || err === 'notMain' || err === 'forbidden' || err === 'offline') {
      // An older main program ("Unknown action"): its 12-hour token simply runs out, as before.
      setSession({ ...cur, noRenew: true });
      return;
    }
    renewRetryAt = Date.now() + RENEW_RETRY_MS; // network or server trouble: try again later
  }).catch(() => { renewRetryAt = Date.now() + RENEW_RETRY_MS; })
    .finally(() => { renewing = null; });
  return renewing;
}

if (typeof window !== 'undefined') {
  setTimeout(renewSession, 0); // a page reloaded close to the end of the token
  setInterval(renewSession, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renewSession(); });
  window.addEventListener('online', () => { renewRetryAt = 0; renewSession(); });
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

// ── Accreditor names (Requested Documents and the admin page share this one copy) ──
// Kept with the session token in this tab, so both pages ask the main program at most once per TTL.
const NAMES_KEY = 'aaccup:v2:accNames';
// Loaded again when older than this, so an accreditor added to or removed from the Access tab
// shows up within minutes (a removed name must never get its folder made again).
export const NAMES_TTL_MS = 2 * 60 * 1000;
let namesPromise = null;

/** The accreditor names: { names, at } (kept with the session token in this tab, for NAMES_TTL_MS). */
export function accreditorList() {
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
/** "Try again" after a failure: ask the server next time instead of using a kept list. */
export function forgetAccreditorList() { store.remove(NAMES_KEY, true); }

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
// Requested Documents in mock mode, like Snapshot.gs / Api.gs:
// details: { fileId: { names, desc } } (✎ Details; the mock JSON's `for` / `desc` are the start)
// folders: { root, names } made by ensureRequestFolders (the mock JSON's subfolders are the start)
function mockRequestStore(code) { return store.get('aaccup:mock:req2:' + code) || {}; }
function mockReqFolders(code) { return store.get('aaccup:mock:reqfolders:' + code) || { root: false, names: [] }; }
const requestSection = (snap) => (snap.sections || []).find((s) => s.code === REQUEST) || null;
const mockFolderId = (code, name) => 'MOCKREQ-' + code + '-' + nameKey(name).replace(/[^a-z0-9]+/g, '-');

/** The staff copy of Requested Documents for a raw mock snapshot (modified in place), or null. */
function mockRequestSection(snap, code) {
  const folders = mockReqFolders(code);
  let sec = requestSection(snap);
  if (!sec && folders.root) {
    sec = { code: REQUEST, name: REQUEST_NAME, folderId: mockFolderId(code, 'root'), files: [], subfolders: [] };
    snap.sections = [...(snap.sections || []), sec];
  }
  if (!sec) return null;
  sec.subfolders = sec.subfolders || [];
  for (const n of folders.names) {
    if (!sec.subfolders.some((s) => !s.path.includes(SUB_SEP) && nameKey(s.path) === nameKey(n))) {
      sec.subfolders.push({ path: n, id: mockFolderId(code, n) });
    }
  }
  sec.subfolders.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const details = mockRequestStore(code);
  for (const f of sec.files) {
    const d = details[f.id];
    f.owner = f.subfolder ? f.subfolder.split(SUB_SEP)[0] : '';
    f.for = d ? d.names : f.for || [];
    const desc = d ? d.desc : f.desc;
    if (desc) f.desc = desc; else delete f.desc;
  }
  return sec;
}

/** Hash of everything the staff copy of Requested Documents shows (so a change reloads it). */
function mockReqHash(sec) {
  let h = 0;
  for (const ch of JSON.stringify(sec ? [sec.subfolders, sec.files.map((f) => [f.id, f.for, f.desc || ''])] : null)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

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
  // Same as Api.gs viewerRequests_: their name folder + files also shown to them; no names, no name folders.
  const mineOnly = (x) => {
    const key = nameKey(name);
    const own = (x.files || []).filter((f) => nameKey(f.owner) === key || (f.for || []).some((n) => nameKey(n) === key));
    if (!key || !own.length) return null;
    const subs = new Set();
    const out = own.map(({ viewUrl, for: _for, owner, subfolder, ...f }) => {
      const parts = subfolder ? subfolder.split(SUB_SEP).slice(1) : [];
      for (let i = 1; i <= parts.length; i++) subs.add(parts.slice(0, i).join(SUB_SEP));
      return parts.length ? { ...f, subfolder: parts.join(SUB_SEP) } : f;
    });
    return { code: x.code, name: x.name, files: out, subfolders: [...subs].sort() };
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
  const s = session?.guest ? session : mockReadToken(authToken(session));
  if (!s) { onExpired(); throw apiError({ error: 'expired', message: 'Your session expired. Please log in again.' }); }
  const snap = await loadMockRaw(prog);
  const kw = mockKeywordStore(prog.code);
  for (const fileId of Object.keys(kw)) {
    for (const hit of locateFile(snap, fileId)) hit.file.keywords = kw[fileId];
  }
  // The hash changes with folders, names and descriptions, so a refresh brings them.
  snap.hash += '.' + mockReqHash(mockRequestSection(snap, prog.code));
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
  const s = mockReadToken(authToken(session));
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
    // Like Security.gs: accreditors 2 hours (renewed), staff 12 hours.
    const loginAt = Date.now();
    const session = { ...user, loginAt, expiresAt: new Date(loginAt + (user.role === 'accreditor' ? 2 : 12) * 3600 * 1000).toISOString() };
    return { ok: true, ...session, token: mockToken(session), expiresIn: (Date.parse(session.expiresAt) - loginAt) / 1000 };
  }
  if (action === 'logout') return { ok: true };
  const s = mockReadToken(payload.token);
  if (!s) return { ok: false, error: 'expired', message: 'Your session expired. Please log in again.' };
  if (action === 'renew') {
    if (prog.code !== mainProgram().code) return { ok: false, error: 'notMain', message: 'Sessions are renewed by the main program.' };
    if (s.role !== 'accreditor') return { ok: false, error: 'invalid', message: 'Only accreditor sessions are renewed.' };
    const cap = (s.loginAt || Date.now()) + 12 * 3600 * 1000;
    const exp = Math.min(Date.now() + 2 * 3600 * 1000, cap);
    const session = { ...s, expiresAt: new Date(exp).toISOString() };
    return { ok: true, role: s.role, name: s.name, token: mockToken(session), expiresAt: session.expiresAt, expiresIn: Math.round((exp - Date.now()) / 1000), final: exp >= cap };
  }
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
    const raw = await loadMockRaw(prog);
    const file = mockRequestSection(raw, prog.code)?.files.find((f) => f.id === payload.fileId);
    if (!file) return { ok: false, error: 'notFound', message: 'This file is not in Requested Documents any more. Tap Refresh.' };
    const names = [];
    for (const r of payload.accreditors) {
      const n = String(r ?? '').replace(/\s+/g, ' ').trim();
      if (n && n.length <= 100 && !/^[=+\-@]/.test(n) && !/[,;]/.test(n) && !names.some((x) => nameKey(x) === nameKey(n))
        && nameKey(n) !== nameKey(file.owner)) names.push(n);
    }
    const desc = payload.description == null ? file.desc || '' : String(payload.description).trim().slice(0, 500);
    const details = mockRequestStore(prog.code);
    details[payload.fileId] = { names, desc }; // kept even when empty, so it overrides the mock JSON's start
    store.set('aaccup:mock:req2:' + prog.code, details);
    return { ok: true, fileId: payload.fileId, accreditors: names, description: desc,
      section: mockRequestSection(await loadMockRaw(prog), prog.code) };
  }
  if (action === 'refreshRequests') {
    if (!staff) return { ok: false, error: 'forbidden', message: 'Coordinators only.' };
    await delay(500);
    return { ok: true, section: mockRequestSection(await loadMockRaw(prog), prog.code) };
  }
  if (action === 'ensureRequestFolders') {
    if (!staff) return { ok: false, error: 'forbidden', message: 'Coordinators only.' };
    await delay(700);
    const folders = mockReqFolders(prog.code);
    const created = [];
    const have = mockRequestSection(await loadMockRaw(prog), prog.code);
    if (!have) { folders.root = true; created.push(REQUEST_NAME); }
    for (const n of payload.names || []) {
      const exists = (have?.subfolders || []).some((s) => !s.path.includes(SUB_SEP) && nameKey(s.path) === nameKey(n))
        || folders.names.some((x) => nameKey(x) === nameKey(n));
      if (!exists) { folders.names.push(n); created.push(n); }
    }
    store.set('aaccup:mock:reqfolders:' + prog.code, folders);
    return { ok: true, created, section: mockRequestSection(await loadMockRaw(prog), prog.code) };
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
