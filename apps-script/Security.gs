/**
 * Security.gs: PINs, login with rate limiting, signed session tokens.
 *
 * Roles. The 6-digit PIN alone decides who is logging in:
 *   accreditor   one PIN per person   view only; only the programs/areas the admin opened
 *                                     (listed by name in the Access tab)
 *   coordinator  one shared PIN       all programs and areas, keywords, Add files, Check now
 *   admin        one PIN              everything, plus the admin panel
 *
 * The MAIN program Sheet (normally Program 1) holds every PIN and handles all logins.
 * It signs each session token with a secret "link key". The other program Sheets get a
 * copy of that key (Setup asks for it), so they accept the same tokens with no PINs of their own.
 *
 * PINs are light protection only. They are stored as salted SHA-256 hashes; the salt and the
 * link key live in Script Properties (not visible in the Sheet).
 */

var PIN_RE = /^\d{6}$/;
var MAX_FAILS = 10;           // wrong PINs (everyone together)…
var FAIL_WINDOW_SEC = 300;    // …within 5 minutes → logins paused until the 5 minutes are over
var TOKEN_SEC = 12 * 3600;    // a session lasts 12 hours
var ROLES = { accreditor: true, coordinator: true, admin: true };

function getSalt_() {
  var p = PropertiesService.getScriptProperties();
  var salt = p.getProperty('PIN_SALT');
  if (!salt) {
    salt = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty('PIN_SALT', salt);
  }
  return salt;
}

function hashPin_(pin) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    getSalt_() + '|' + String(pin).trim(), Utilities.Charset.UTF_8));
}

function safeEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function apiError_(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

// ── Main vs linked Sheet ─────────────────────────────────────
function isMain_() {
  return String(getConfig_().authMode || 'main').toLowerCase() !== 'linked';
}

function requireMain_() {
  if (isMain_()) return true;
  var ui = SpreadsheetApp.getUi();
  ui.alert('PINs are managed in the main Sheet',
    'This Sheet is linked to the main program, so it has no PINs of its own.\n' +
    'Set PINs in the MAIN program Sheet (normally Program 1). They work for every program.', ui.ButtonSet.OK);
  return false;
}

function getTokenKey_() {
  var p = PropertiesService.getScriptProperties();
  var key = p.getProperty('TOKEN_KEY');
  if (!key && isMain_()) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    p.setProperty('TOKEN_KEY', key);
  }
  if (!key) throw apiError_('server', 'This program is not linked yet. Run AACCUP → Setup and paste the link key.');
  return key;
}

// ── Login ────────────────────────────────────────────────────
/** Returns { role, name } or throws badPin / locked / notMain. */
function verifyLogin_(pin) {
  if (!isMain_()) throw apiError_('notMain', 'Logins go through the main program. Check config.js: the main program must be listed first.');
  pin = String(pin || '').trim();
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  var ttl = function (f) { return Math.max(1, Math.ceil((f.t + FAIL_WINDOW_SEC * 1000 - Date.now()) / 1000)); };
  var readFails = function () {
    try { return JSON.parse(cache.get('loginFails') || 'null'); } catch (e) { return null; }
  };

  // Count the attempt under the lock BEFORE checking the PIN, so parallel requests can't
  // all read the same counter and slip past MAX_FAILS.
  if (!lock.tryLock(10000)) throw apiError_('busy', 'The server is busy. Please try again in a few seconds.');
  var f;
  try {
    var now = Date.now();
    f = readFails();
    if (!f || now - f.t > FAIL_WINDOW_SEC * 1000) f = { n: 0, t: now };
    if (f.n >= MAX_FAILS) throw apiError_('locked', 'Too many wrong PINs. Wait 5 minutes, then try again.');
    f.n++;
    cache.put('loginFails', JSON.stringify(f), ttl(f));
  } finally {
    lock.releaseLock();
  }

  // Give the reserved attempt back (correct PIN, or a server error while checking it).
  // Waits longer than the first lock so it outlasts a snapshot save holding the lock.
  var giveBack = function () {
    if (!lock.tryLock(15000)) return;
    try {
      var g = readFails();
      if (g && g.t === f.t && g.n > 0) { g.n--; cache.put('loginFails', JSON.stringify(g), ttl(g)); }
    } finally {
      lock.releaseLock();
    }
  };

  var session;
  try {
    session = PIN_RE.test(pin) ? findPinOwner_(hashPin_(pin)) : null;
  } catch (e) {
    giveBack();
    throw e;
  }
  if (!session) {
    log_('loginFailed', '', 'attempt ' + f.n);
    throw apiError_('badPin', 'Wrong PIN. Please try again.');
  }
  giveBack();
  return session;
}

function findPinOwner_(h) {
  var cfg = getConfig_();
  if (safeEqual_(h, cfg.adminPinHash)) return { role: 'admin', name: 'Admin' };
  if (safeEqual_(h, cfg.coordinatorPinHash)) return { role: 'coordinator', name: 'Coordinator' };
  var hit = null;
  readAccess_().forEach(function (r) {
    if (!hit && safeEqual_(h, r.pinHash)) hit = { role: 'accreditor', name: r.accreditorName || 'Accreditor' };
  });
  return hit;
}

/**
 * Every PIN must be unique, because the PIN alone decides who is logging in.
 * `self` is the slot being changed: 'admin', 'coordinator' or 'acc:<name>'.
 * Returns who already uses this PIN, or null.
 */
function pinInUse_(h, self) {
  var cfg = getConfig_();
  if (self !== 'admin' && safeEqual_(h, cfg.adminPinHash)) return 'the admin';
  if (self !== 'coordinator' && safeEqual_(h, cfg.coordinatorPinHash)) return 'the coordinators';
  var who = null;
  readAccess_().forEach(function (r) {
    if (!who && self !== 'acc:' + r.accreditorName.toLowerCase() && safeEqual_(h, r.pinHash)) who = r.accreditorName;
  });
  return who;
}

// ── Signed tokens (checked by every program Sheet with the shared link key) ──
function sign_(payload) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, getTokenKey_(), Utilities.Charset.UTF_8));
}

function issueToken_(session) {
  var exp = Date.now() + TOKEN_SEC * 1000;
  var payload = Utilities.base64EncodeWebSafe(
    JSON.stringify({ r: session.role, n: session.name, x: exp }), Utilities.Charset.UTF_8);
  return { token: payload + '.' + sign_(payload), expiresAt: new Date(exp).toISOString() };
}

/** need: 'any' | 'staff' (coordinator or admin) | 'admin'. Returns { role, name }. */
function checkToken_(token, need) {
  var expired = function () { return apiError_('expired', 'Your session expired. Please log in again.'); };
  var parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw expired();
  if (!safeEqual_(sign_(parts[0]), parts[1])) {
    // On a linked Sheet a bad signature means its link key differs from the main one.
    // The main Sheet issued the token itself, so there it just means an old token.
    if (isMain_()) throw expired();
    throw apiError_('notLinked', 'This program is not linked to the main program (link key mismatch). Ask the admin to re-run Link to main program.');
  }
  var data;
  try {
    data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8'));
  } catch (e) {
    throw expired();
  }
  if (!data || !ROLES[data.r] || !(Number(data.x) > Date.now())) throw expired();
  var s = { role: data.r, name: String(data.n || '') };
  // An accreditor removed from (or renamed in) the Access tab loses access at once, not when the
  // 12-hour token runs out. Checked on the main program: its "expired" ends the whole session
  // on the website (see endsSession in api.js), so the linked programs stop being asked too.
  if (s.role === 'accreditor' && isMain_() && !accreditorStillListed_(s.name)) {
    throw apiError_('expired', 'Your access has ended. Please contact the accreditation coordinator.');
  }
  if (need === 'admin' && s.role !== 'admin') throw apiError_('forbidden', 'Admin only.');
  if (need === 'staff' && s.role === 'accreditor') throw apiError_('forbidden', 'Coordinators only.');
  return s;
}

var ACCESS_TTL = 120; // seconds; editing the Access tab clears it at once (onEdit in Code.gs)

/** Main program: is an accreditor with this name (as in their token) still in the Access tab with a PIN? */
function accreditorStillListed_(name) {
  var cache = CacheService.getScriptCache();
  var list = null;
  var raw = cache.get('accessNames');
  if (raw) { try { list = JSON.parse(raw); } catch (e) { list = null; } }
  if (!list) {
    // Same name as findPinOwner_ puts in the token ('Accreditor' for a row without a name).
    list = readAccess_().filter(function (r) { return r.pinHash; })
      .map(function (r) { return (r.accreditorName || 'Accreditor').toLowerCase(); });
    cache.put('accessNames', JSON.stringify(list), ACCESS_TTL);
  }
  return list.indexOf(String(name || '').trim().toLowerCase()) !== -1;
}

// ── Menu actions (run from the Sheet) ───────────────────────
function setAdminPin() {
  if (!requireMain_()) return;
  setRolePin_('admin', 'adminPinHash', 'Set admin PIN', 'the admin');
}

function setCoordinatorPin() {
  if (!requireMain_()) return;
  setRolePin_('coordinator', 'coordinatorPinHash', 'Set coordinator PIN', 'all coordinators (one shared PIN)');
}

function setRolePin_(self, key, title, forWhom) {
  var ui = SpreadsheetApp.getUi();
  var pin = promptText_(title, 'PIN for ' + forWhom + ': type 6 digits, or leave blank to generate a random one. Only its hash is saved.', '');
  if (pin === null) return;
  var generated = !pin;
  if (generated) pin = randomUniquePin_(self, {});
  if (!PIN_RE.test(pin)) { ui.alert('The PIN must be exactly 6 digits.'); return; }
  var h = hashPin_(pin);
  var who = pinInUse_(h, self);
  if (who) { ui.alert('That PIN is already used by ' + who + '. Choose another one.'); return; }
  setConfig_(key, h);
  log_('set' + self.charAt(0).toUpperCase() + self.slice(1) + 'Pin', Session.getActiveUser().getEmail(), '');
  ui.alert(title, (generated ? 'New PIN: ' + pin + '\n\nWrite it down now. It is not stored anywhere (only its hash).' : 'PIN saved.') +
    '\n\nIt works for every program linked to this Sheet.', ui.ButtonSet.OK);
}

/** One accreditor: add a row to the Access tab, or change that person's PIN. */
function setAccreditorPin() {
  if (!requireMain_()) return;
  var ui = SpreadsheetApp.getUi();
  var name = promptText_('Accreditor PIN (1/2)', 'Accreditor name (shown on the site, in the watermark and in the Log):', '');
  if (name === null || !name) return;
  var self = 'acc:' + name.toLowerCase();
  var pin = promptText_('Accreditor PIN (2/2)', 'PIN for ' + name + ': type 6 digits, or leave blank to generate one.', '');
  if (pin === null) return;
  var generated = !pin;
  if (generated) pin = randomUniquePin_(self, {});
  if (!PIN_RE.test(pin)) { ui.alert('The PIN must be exactly 6 digits.'); return; }
  var h = hashPin_(pin);
  var who = pinInUse_(h, self);
  if (who) { ui.alert('That PIN is already used by ' + who + '. Choose another one.'); return; }
  var sh = sheet_('Access');
  var row = readAccess_().filter(function (r) { return r.accreditorName.toLowerCase() === name.toLowerCase(); })[0];
  if (row) sh.getRange(row._row, 1, 1, 2).setValues([[name, h]]);
  else sh.appendRow([name, h]);
  log_('setAccreditorPin', Session.getActiveUser().getEmail(), name);
  ui.alert('Accreditor PIN', 'PIN saved for ' + name + (generated ? ': ' + pin + '\n\nWrite it down now.' : '.'), ui.ButtonSet.OK);
}

/** PINs for every accreditor listed in the Access tab. */
function generatePins() {
  if (!requireMain_()) return;
  var ui = SpreadsheetApp.getUi();
  var rows = readAccess_().filter(function (r) { return r.accreditorName; });
  if (!rows.length) {
    ui.alert('The Access tab is empty. Add one row per accreditor (their name in column A), then run this again.');
    return;
  }
  var choice = ui.alert('Generate accreditor PINs',
    'YES = only for accreditors who have no PIN yet.\nNO = new PINs for EVERY accreditor (their old PINs stop working).',
    ui.ButtonSet.YES_NO_CANCEL);
  if (choice === ui.Button.CANCEL || choice === ui.Button.CLOSE) return;
  var onlyEmpty = choice === ui.Button.YES;
  var sh = sheet_('Access');
  var out = [];
  var taken = {};
  rows.forEach(function (r) {
    if (onlyEmpty && r.pinHash) return;
    var pin = randomUniquePin_('acc:' + r.accreditorName.toLowerCase(), taken);
    var h = hashPin_(pin);
    taken[h] = true;
    sh.getRange(r._row, 1, 1, 2).setValues([[r.accreditorName, h]]);
    out.push([r.accreditorName, pin]);
  });
  if (!out.length) { ui.alert('Every accreditor already has a PIN.'); return; }
  var html = '<div style="font:14px Arial,sans-serif">' +
    '<p><b>Copy these now.</b> They are not stored anywhere (only their hashes). Give each accreditor their own PIN. ' +
    'Each PIN works for every program.</p>' +
    '<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">' +
    '<tr><th>Accreditor</th><th>PIN</th></tr>' +
    out.map(function (r) {
      return '<tr><td>' + esc_(r[0]) + '</td><td style="font:bold 16px monospace">' + r[1] + '</td></tr>';
    }).join('') + '</table></div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(480).setHeight(460), 'New accreditor PINs');
  log_('generatePins', Session.getActiveUser().getEmail(), out.length + ' PIN(s)');
}

/** Random 6-digit PIN not used by anyone else (nor in `taken`, a set of hashes). */
function randomUniquePin_(self, taken) {
  for (var i = 0; i < 50; i++) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    var pin = ('000000' + (parseInt(hex.slice(0, 12), 16) % 1000000)).slice(-6);
    var h = hashPin_(pin);
    if (!taken[h] && !pinInUse_(h, self)) return pin;
  }
  throw new Error('Could not generate a unique PIN. Try again.');
}

// ── Linking other program Sheets to the main one ────────────
function showLinkKey() {
  var ui = SpreadsheetApp.getUi();
  if (!isMain_()) {
    ui.alert('This Sheet is linked to the main program. Open the MAIN program Sheet to see the link key.');
    return;
  }
  ui.alert('Link key',
    'Paste this key into every OTHER program Sheet (AACCUP → Setup, or AACCUP → Link to main program):\n\n' +
    getTokenKey_() + '\n\nKeep it private: anyone with it could create logins.', ui.ButtonSet.OK);
}

function linkToMain() {
  var ui = SpreadsheetApp.getUi();
  if (isMain_() && getConfig_().authMode) {
    var r = ui.alert('This is the main Sheet',
      'This Sheet is set as the MAIN program. Turn it into a linked Sheet instead? Its PINs will no longer be used.',
      ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;
  }
  var key = promptText_('Link to main program',
    'In the MAIN program Sheet, run AACCUP → Show link key, then paste the key here.', '');
  if (key === null) return;
  key = key.replace(/\s+/g, '');
  if (!/^[a-f0-9]{64}$/.test(key)) { ui.alert('That does not look like a link key (64 letters and digits).'); return; }
  PropertiesService.getScriptProperties().setProperty('TOKEN_KEY', key);
  setConfig_('authMode', 'linked');
  log_('linkToMain', Session.getActiveUser().getEmail(), '');
  ui.alert('Linked. This program now accepts logins from the main program.');
}

function esc_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
