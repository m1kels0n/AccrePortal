/**
 * Api.gs: web app endpoints + viewer settings.
 * Deploy as: Web app · Execute as: Me · Who has access: Anyone.
 *
 * GET  ?action=ping
 * GET  ?action=snapshot&token=<token>[&since=<hash>][&ref=0]
 *        The admin and coordinators get the full snapshot. With ref=0 (the website) it comes
 *        without the Reference folders (refLazy: true, plus refHash and refCount); the All files
 *        page loads those with action=reference. Without ref=0 they are included, as before.
 *        Accreditors get only the areas the admin opened, without Drive folder links
 *        (error "noAccess" if the program is closed to them). Never any Reference folders.
 *        Requested Documents: only the files ticked for that accreditor, without the names.
 *        since=<hash> answers { unchanged: true } when nothing changed, without the file list.
 * GET  ?action=reference&token=<token>[&since=<refHash>]   (coordinator or admin)
 *        { refHash, reference: [...] }: the Reference folders only.
 * POST (body = JSON text, sent as text/plain to avoid a CORS preflight)
 *      { action: 'login', pin }                 (main program only)
 *      { action: 'logout', token }
 *      { action: 'saveKeywords', token, fileId, keywords }   (coordinator or admin)
 *      Requested Documents (coordinator or admin):
 *      { action: 'saveRequestAccess', token, fileId, accreditors: [names], description? }
 *        extra accreditors (besides the one whose name folder holds the file) and a description
 *      { action: 'refreshRequests', token }   small scan of the Requested Documents folder only
 *      { action: 'ensureRequestFolders', token, names: [names] }   create the folder and one
 *        subfolder per accreditor name if missing (names come from the main program's Access tab)
 *        Both reply { section, hashFrom, hashTo } with the section as the staff snapshot has it.
 *      { action: 'checkNow', token }            (coordinator or admin: rescan Drive now)
 *      { action: 'refresh', token }             (admin)
 *      { action: 'rebuildStructure', token }    (admin)
 *      { action: 'issues', token }              (admin)
 *      { action: 'saveSettings', token, accreditorEnabled?, accreditorAreas?, watermark? }   (admin)
 *        With accreditor: '<name>' the change is that one accreditor's own setting for this program
 *        (reset: true removes it, back to the program-wide setting). No watermark per accreditor.
 *      { action: 'accreditors', token }         (coordinator or admin, main program: names from the Access tab)
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'ping') {
      var cfg = getConfig_();
      return json_({
        ok: true,
        program: cfg.programCode,
        main: isMain_(),
        time: new Date().toISOString(),
        lastScan: PropertiesService.getScriptProperties().getProperty('LAST_SCAN'),
      });
    }
    if (!p.action || p.action === 'snapshot') {
      var session = checkToken_(p.token, 'any');
      return reply_(snapshotFor_(session, p.since, p.ref === '0'));
    }
    if (p.action === 'reference') {
      checkToken_(p.token, 'staff');
      return reply_(referenceFor_(p.since));
    }
    return json_({ ok: false, error: 'invalid', message: 'Unknown action.' });
  } catch (err) {
    if (err && err.code) return json_({ ok: false, error: err.code, message: err.message });
    console.error('doGet: ' + err);
    return json_({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (x) {
    return json_({ ok: false, error: 'invalid', message: 'Bad request.' });
  }
  try {
    switch (body.action) {
      case 'login': return json_(handleLogin_(body));
      case 'logout': return json_({ ok: true });
      case 'saveKeywords': return json_(handleSaveKeywords_(body));
      case 'saveRequestAccess': return json_(handleSaveRequestAccess_(body));
      case 'refreshRequests': return json_(handleRefreshRequests_(body));
      case 'ensureRequestFolders': return json_(handleEnsureRequestFolders_(body));
      case 'checkNow': return json_(handleCheckNow_(body));
      case 'refresh': return json_(handleRefresh_(body));
      case 'rebuildStructure': return json_(handleRebuild_(body));
      case 'issues': return json_(handleIssues_(body));
      case 'saveSettings': return json_(handleSaveSettings_(body));
      case 'accreditors': return json_(handleAccreditors_(body));
      default: return json_({ ok: false, error: 'invalid', message: 'Unknown action.' });
    }
  } catch (err) {
    if (err && err.code) return json_({ ok: false, error: err.code, message: err.message });
    console.error('doPost ' + body.action + ': ' + (err && err.stack || err));
    log_('apiError', body.action, String(err && err.message || err));
    return json_({ ok: false, error: 'server', message: 'Server error. Please try again.' });
  }
}

function handleLogin_(body) {
  var session = verifyLogin_(body.pin);
  var t = issueToken_(session);
  log_('login', session.name + ' (' + session.role + ')', '');
  return { ok: true, role: session.role, name: session.name, token: t.token, expiresAt: t.expiresAt };
}

// ── Snapshot, filtered by role ───────────────────────────────
var NOT_READY = { ok: false, error: 'notReady', message: 'No snapshot yet. Run AACCUP → Build snapshot now.' };

/**
 * `lazyRef` (ref=0): leave the Reference folders out (the website loads them on the All files page).
 * When `since` still matches, only the cached meta is read, not the file list itself.
 * Returns an object, or { raw: '<json text>' } for a snapshot sent as cached (no parse / stringify).
 */
function snapshotFor_(session, since, lazyRef) {
  var st = readSettings_();
  var m = snapMeta_();

  if (session.role !== 'accreditor') {
    // The admin also gets each accreditor's own settings (for the admin panel); coordinators don't.
    var shown = session.role === 'admin' ? adminSettings_(st) : st;
    // Without ref=0 the Reference folders are in the reply, so they are part of its hash too.
    var hashOf = function (meta) { return lazyRef ? meta.hash : meta.hash + '~' + (meta.refHash || ''); };
    if (since && m && hashOf(m) === since) {
      return { ok: true, unchanged: true, hash: since, generatedAt: m.generatedAt, settings: shown,
               refHash: m.refHash, refCount: m.refCount };
    }
    var c = readSnapshot_();
    if (!c) return NOT_READY;
    // The cached text is a JSON object: add the fields before its closing brace. A repeated
    // key (generatedAt, hash) replaces the earlier one when the browser parses it.
    var tail = ',"settings":' + JSON.stringify(shown) + ',"generatedAt":' + JSON.stringify(c.meta.generatedAt || '');
    if (lazyRef) return { raw: c.text.slice(0, -1) + tail + ',"refLazy":true}' };
    var r = readReference_(); // Reference folders included: admin and coordinators see them in All files
    return { raw: c.text.slice(0, -1) + ',"reference":' + (r ? r.text : '[]') + tail +
                  ',"hash":' + JSON.stringify(hashOf(c.meta)) + '}' };
  }

  // This accreditor's own settings for the program if the admin set any, else the program-wide ones.
  var mine = settingsFor_(st, session.name);
  if (!mine.accreditorEnabled) throw apiError_('noAccess', 'This program is not open to accreditors.');
  var pub = { watermark: st.watermark };
  // Each accreditor gets their own Requested Documents, so the name is part of the version key.
  var areasKey = '.' + md5_(JSON.stringify([mine.accreditorAreas, String(session.name || '').toLowerCase()])).slice(0, 8);
  if (since && m && since === m.hash + areasKey) {
    return { ok: true, unchanged: true, hash: since, generatedAt: m.generatedAt, settings: pub };
  }
  var cs = readSnapshot_();
  if (!cs) return NOT_READY;
  var hash = cs.meta.hash + areasKey;
  if (since && since === hash) {
    return { ok: true, unchanged: true, hash: hash, generatedAt: cs.meta.generatedAt, settings: pub };
  }
  var snap = JSON.parse(cs.text);
  var allowed = mine.accreditorAreas === 'ALL' ? null : toSet_(mine.accreditorAreas.map(normalizeAreaCode_));
  return {
    schema: snap.schema,
    program: { code: snap.program.code, name: snap.program.name },
    generatedAt: cs.meta.generatedAt || snap.generatedAt,
    hash: hash,
    looseFiles: (snap.looseFiles || []).map(viewerFile_),
    // Sections (Compliance Report, PPP, Actual Self-Survey Report) are opened and hidden like areas.
    // Requested Documents is not in the admin's list: the names ticked on each file decide.
    sections: (snap.sections || []).filter(function (x) {
      return x.code === REQUEST_SECTION || !allowed || allowed[normalizeAreaCode_(x.code)];
    }).map(function (x) {
      if (x.code === REQUEST_SECTION) return viewerRequests_(x, session.name);
      return { code: x.code, name: x.name, files: x.files.map(viewerFile_),
               subfolders: (x.subfolders || []).map(function (s) { return typeof s === 'string' ? s : s.path; }) };
    }).filter(Boolean),
    areas: snap.areas.filter(function (a) { return !allowed || allowed[normalizeAreaCode_(a.code)]; }).map(viewerArea_),
    settings: pub,
  };
}

/** Reference folders for the All files page (coordinators and admin; the caller checked the token). */
function referenceFor_(since) {
  var m = snapMeta_();
  if (since && m && m.refHash === since) return { ok: true, unchanged: true, refHash: since };
  var r = readReference_();
  if (!r) return NOT_READY;
  return { raw: '{"ok":true,"refHash":' + JSON.stringify(r.refHash) + ',"reference":' + r.text + '}' };
}

/**
 * Accreditor copy of an area: no Drive folder IDs, no "open in Drive" links.
 * Files directly in the area / parameter folders (looseFiles) are kept: the site shows them as "General documents".
 */
function viewerArea_(a) {
  return {
    code: a.code, name: a.name, looseFiles: (a.looseFiles || []).map(viewerFile_),
    parameters: a.parameters.map(function (p) {
      return {
        code: p.code, name: p.name, looseFiles: (p.looseFiles || []).map(viewerFile_),
        indicators: p.indicators.map(function (i) {
          return {
            code: i.code, type: i.type, text: i.text,
            files: i.files.map(viewerFile_),
            // Folder names only: no Drive IDs for accreditors.
            subfolders: (i.subfolders || []).map(function (s) { return typeof s === 'string' ? s : s.path; }),
          };
        }),
      };
    }),
  };
}

/**
 * One accreditor's copy of Requested Documents: the files in the folder named after them, plus
 * files a coordinator also showed to them, compared with nameKey_. The name folder itself is left
 * out of the paths (no other accreditor's folder name shows), and so are the coordinators' lists
 * of names. The description is kept. Null when nothing is for them.
 */
function viewerRequests_(sec, name) {
  var key = nameKey_(name);
  if (!key) return null;
  var files = (sec.files || []).filter(function (f) {
    return nameKey_(f.owner) === key || (f.for || []).some(function (n) { return nameKey_(n) === key; });
  });
  if (!files.length) return null;
  var subs = {};
  var out = files.map(function (f) {
    var o = viewerFile_(f);
    delete o.subfolder;
    // "Dr. Reyes › Area 2" → "Area 2"; a file right in a name folder sits at the top.
    var parts = f.subfolder ? String(f.subfolder).split(' › ').slice(1) : [];
    if (parts.length) o.subfolder = parts.join(' › ');
    for (var i = 1; i <= parts.length; i++) subs[parts.slice(0, i).join(' › ')] = true;
    if (f.desc) o.desc = f.desc;
    return o;
  });
  return { code: sec.code, name: sec.name, files: out, subfolders: Object.keys(subs).sort() };
}

/** Accreditor copy of a file. A folder shortcut would preview as a browsable Drive folder (other areas, Drive links). */
function viewerFile_(f) {
  var o = { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, modified: f.modified,
            previewUrl: f.mimeType === FOLDER_MIME ? null : f.previewUrl, keywords: f.keywords || [] };
  if (f.subfolder) o.subfolder = f.subfolder;
  return o;
}

// ── Viewer settings (Config tab: accreditorEnabled, accreditorAreas, watermark) ──
// Cached for 10 minutes, so most requests don't have to open the Sheet. Saving in the admin panel
// clears the cache at once, and so does editing the Config / AccreditorAccess tab (onEdit in Code.gs).
var SETTINGS_TTL = 600;

function readSettings_() {
  var cache = CacheService.getScriptCache();
  var raw = cache.get('settings');
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* rebuild below */ } }
  var cfg = getConfig_();
  var flag = function (v) { return v === undefined || String(v).trim() === '' ? true : isTrue_(v); };
  var s = { accreditorEnabled: flag(cfg.accreditorEnabled), accreditorAreas: parseAreas_(cfg.accreditorAreas), watermark: flag(cfg.watermark) };
  cache.put('settings', JSON.stringify(s), SETTINGS_TTL);
  return s;
}

/** "ALL" (or blank) → 'ALL', "NONE" → [], otherwise a list of normalized area codes. */
function parseAreas_(raw) {
  raw = String(raw === null || raw === undefined ? '' : raw).trim();
  return /^(all)?$/i.test(raw) ? 'ALL'
    : /^none$/i.test(raw) ? []
    : raw.split(/[,;\s]+/).map(normalizeAreaCode_).filter(Boolean);
}

/** The text stored for an area choice: 'ALL', 'NONE', or the real area codes separated by commas. */
function cleanAreasValue_(a) {
  if (a === 'ALL') return 'ALL';
  if (Object.prototype.toString.call(a) !== '[object Array]') throw apiError_('invalid', 'Bad area list.');
  // Store each area's real code from the current snapshot (key → code); without one,
  // keep plain codes. Separators are refused because parseAreas_ splits on them.
  var real = null;
  try {
    var c = readSnapshot_();
    if (c) {
      real = {};
      var sn = JSON.parse(c.text);
      (sn.areas || []).concat(sn.sections || []).forEach(function (ar) { real[normalizeAreaCode_(ar.code)] = String(ar.code); });
    }
  } catch (e) { real = null; }
  var seen = {};
  return a.map(function (x) {
    if (real) return real[normalizeAreaCode_(x)] || '';
    x = String(x === null || x === undefined ? '' : x).trim();
    return /^[A-Za-z0-9.\-]{1,48}$/.test(x) ? x : '';
  }).filter(function (x) {
    var k = normalizeAreaCode_(x);
    if (!x || /[,;\s]/.test(x) || seen[k]) return false;
    seen[k] = true;
    return true;
  }).join(', ') || 'NONE';
}

// ── Per-accreditor overrides (AccreditorAccess tab: name, enabled, areas) ──
// An accreditor with a row here gets that row's settings for THIS program; everyone else
// follows the program-wide settings above. Names match the Access tab, ignoring case.
var OVERRIDES_TAB = 'AccreditorAccess';

function readOverrides_() {
  var cache = CacheService.getScriptCache();
  var raw = cache.get('overrides');
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* rebuild below */ } }
  var list = [];
  var sh = ss_().getSheetByName(OVERRIDES_TAB); // missing until the first override is saved
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
      var name = String(r[0] || '').trim();
      if (!name) return;
      list.push({ name: name, enabled: String(r[1]).trim() === '' ? true : isTrue_(r[1]), areas: parseAreas_(r[2]) });
    });
  }
  cache.put('overrides', JSON.stringify(list), SETTINGS_TTL);
  return list;
}

function overrideFor_(name) {
  var key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return readOverrides_().filter(function (o) { return o.name.toLowerCase() === key; })[0] || null;
}

/** The viewer settings that apply to one accreditor in this program. */
function settingsFor_(st, name) {
  var ov = overrideFor_(name);
  return ov ? { accreditorEnabled: ov.enabled, accreditorAreas: ov.areas, watermark: st.watermark } : st;
}

/** Settings as the admin panel sees them: the program-wide ones plus every accreditor's own. */
function adminSettings_(st) {
  return { accreditorEnabled: st.accreditorEnabled, accreditorAreas: st.accreditorAreas, watermark: st.watermark,
           overrides: readOverrides_() };
}

function handleSaveSettings_(body) {
  var s = checkToken_(body.token, 'admin');
  var who = body.accreditor === undefined || body.accreditor === null ? '' : String(body.accreditor).trim();
  var areasV = body.accreditorAreas !== undefined ? cleanAreasValue_(body.accreditorAreas) : undefined;
  if (who) {
    if (body.watermark !== undefined) throw apiError_('invalid', 'The watermark is not set per accreditor.');
    saveOverride_(who, body.reset === true, body.accreditorEnabled, areasV);
    log_('settings', 'admin:' + s.name, 'accreditor ' + who + (body.reset === true ? ': back to program default'
      : ': ' + (body.accreditorEnabled === undefined ? '' : (body.accreditorEnabled ? 'open' : 'closed') + ' ') + (areasV || '')));
  } else {
    if (body.accreditorEnabled !== undefined) setConfig_('accreditorEnabled', body.accreditorEnabled ? 'TRUE' : 'FALSE');
    if (areasV !== undefined) setConfig_('accreditorAreas', areasV);
    if (body.watermark !== undefined) setConfig_('watermark', body.watermark ? 'TRUE' : 'FALSE');
  }
  CacheService.getScriptCache().remove('settings');
  var st = readSettings_();
  if (!who) log_('settings', 'admin:' + s.name, JSON.stringify(st));
  return { ok: true, settings: adminSettings_(st) };
}

/** Add, change or (reset) remove one accreditor's row in the AccreditorAccess tab. */
function saveOverride_(name, reset, enabled, areasV) {
  // Names are written into a Sheet cell: refuse anything a Sheet would treat as a formula.
  if (name.length > 100 || /^[=+\-@]/.test(name)) throw apiError_('invalid', 'Bad accreditor name.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'The server is busy. Please try again in a few seconds.');
  try {
    var ss = ss_();
    var sh = ss.getSheetByName(OVERRIDES_TAB);
    if (!sh) {
      if (reset) return;
      sh = ss.insertSheet(OVERRIDES_TAB);
      sh.getRange(1, 1, 1, 3).setValues([SHEET_HEADERS[OVERRIDES_TAB]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    var n = Math.max(sh.getLastRow() - 1, 0);
    var names = n ? sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0] || '').trim().toLowerCase(); }) : [];
    var i = names.indexOf(name.toLowerCase());
    if (reset) {
      if (i !== -1) sh.deleteRow(i + 2);
    } else {
      var st = readSettings_();
      var cur = i === -1 ? null : sh.getRange(i + 2, 1, 1, 3).getValues()[0];
      var curEnabled = cur ? (String(cur[1]).trim() === '' ? true : isTrue_(cur[1])) : st.accreditorEnabled;
      var curAreas = cur ? String(cur[2] || 'ALL') : (st.accreditorAreas === 'ALL' ? 'ALL' : [].concat(st.accreditorAreas).join(', ') || 'NONE');
      var row = [cur ? cur[0] : name,
                 (enabled === undefined ? curEnabled : !!enabled) ? 'TRUE' : 'FALSE',
                 areasV === undefined ? curAreas : areasV];
      if (i === -1) sh.appendRow(row);
      else sh.getRange(i + 2, 1, 1, 3).setValues([row]);
    }
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('overrides');
}

/**
 * Coordinators and admin, main program only: the accreditor names from the Access tab (never
 * their PINs). The admin panel uses them for "Settings for"; coordinators to tick who a
 * Requested Documents file is for.
 */
function handleAccreditors_(body) {
  checkToken_(body.token, 'staff');
  if (!isMain_()) throw apiError_('notMain', 'The accreditor list is kept on the main program.');
  var seen = {};
  var names = readAccess_().map(function (r) { return r.accreditorName; }).filter(function (n) {
    var k = n.toLowerCase();
    if (!n || seen[k]) return false;
    seen[k] = true;
    return true;
  });
  return { ok: true, names: names };
}

// ── Coordinator / admin actions ──────────────────────────────
function handleSaveKeywords_(body) {
  var s = checkToken_(body.token, 'staff');
  var fileId = String(body.fileId || '').trim();
  if (!/^[-\w]{10,}$/.test(fileId)) throw apiError_('invalid', 'Invalid file.');
  var keywords = cleanKeywords_(body.keywords);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'The server is busy. Please try again in a few seconds.');
  try {
    var snap = readFullSnapshot_();
    if (!snap) throw apiError_('notFound', 'No snapshot yet.');
    // Any file in the snapshot, Reference folders included (admin and coordinators both see them).
    if (!hasFile_(snap, fileId)) throw apiError_('notFound', 'File not found. It may have been moved or deleted. Reload the page.');
    upsertKeywords_(fileId, keywords, s.name);
    // The hashes before and after: a page that had the "before" version and made this same
    // change itself is up to date, so it doesn't need to download the file list again.
    var before = { hash: snap.hash, refHash: snap.refHash };
    patchSnapshotKeywords_(snap, fileId, keywords);
  } finally {
    lock.releaseLock();
  }
  log_('keywords', s.name, fileId + ': ' + keywords.join(', '));
  return { ok: true, fileId: fileId, keywords: keywords, updatedAt: new Date().toISOString(),
           hashFrom: before.hash, hashTo: snap.hash, refHashFrom: before.refHash, refHashTo: snap.refHash };
}

/** Extra accreditors and the description of a Requested Documents file (✎ Details). */
function handleSaveRequestAccess_(body) {
  var s = checkToken_(body.token, 'staff');
  var fileId = String(body.fileId || '').trim();
  if (!/^[-\w]{10,}$/.test(fileId)) throw apiError_('invalid', 'Invalid file.');
  if (Object.prototype.toString.call(body.accreditors) !== '[object Array]') throw apiError_('invalid', 'Bad accreditor list.');
  var names = cleanNames_(body.accreditors);
  var desc;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'The server is busy. Please try again in a few seconds.');
  try {
    var snap = readFullSnapshot_();
    if (!snap) throw apiError_('notFound', 'No snapshot yet.');
    var file = requestFile_(snap, fileId);
    if (!file) {
      throw apiError_('notFound', 'This file is not in Requested Documents any more. It may have been moved or deleted. Tap Refresh.');
    }
    // No description sent: keep the one saved.
    desc = body.description === undefined || body.description === null ? (file.desc || '') : cleanDesc_(body.description);
    // The name folder's own accreditor needs no extra row.
    names = names.filter(function (n) { return nameKey_(n) !== nameKey_(file.owner); });
    upsertRequest_(fileId, names, desc, s.name);
    var before = snap.hash;
    file.for = names;
    if (desc) file.desc = desc; else delete file.desc;
    setSnapshotHashes_(snap);
    cacheSnapshot_(snap);
    PropertiesService.getScriptProperties().deleteProperty('SNAP_HASH');
  } finally {
    lock.releaseLock();
  }
  log_('requestDetails', s.name, fileId + ': ' + (names.join(', ') || '-') + (desc ? ' · ' + desc.slice(0, 80) : ''));
  return { ok: true, fileId: fileId, accreditors: names, description: desc, section: requestSection_(snap),
           hashFrom: before, hashTo: snap.hash };
}

var REQUEST_COOLDOWN_SEC = 4;   // per session: Refresh is cheap, but a stuck button shouldn't loop

/** ↻ Refresh on the Requested Documents pages: scan only that folder (about 2 Drive requests). */
function handleRefreshRequests_(body) {
  var s = checkToken_(body.token, 'staff');
  var cache = CacheService.getScriptCache();
  var key = 'req:' + md5_(String(body.token));
  if (cache.get(key)) throw apiError_('tooSoon', 'You just refreshed. Please wait a few seconds, then try again.');
  cache.put(key, '1', REQUEST_COOLDOWN_SEC);
  var c = readSnapshot_();
  if (!c) throw apiError_('notFound', 'No snapshot yet.');
  var old = requestSection_(JSON.parse(c.text));
  if (!old || !old.folderId || old.folderId === getConfig_().rootFolderId) {
    return { ok: true, section: null }; // no Requested Documents folder yet
  }
  var res = saveRequestSection_(scanRequestFolder_(old.folderId, old.name));
  log_('requestRefresh', s.name, res.section.files.length + ' files');
  return res;
}

/**
 * Create Requested Documents and one subfolder per accreditor name when missing, then return
 * the section (rescanned). The website calls it only when a name has no folder yet.
 */
function handleEnsureRequestFolders_(body) {
  var s = checkToken_(body.token, 'staff');
  if (Object.prototype.toString.call(body.names) !== '[object Array]') throw apiError_('invalid', 'Bad name list.');
  var names = cleanNames_(body.names);
  var cfg = requireConfig_(['rootFolderId']);
  var c = readSnapshot_();
  if (!c) throw apiError_('notFound', 'No snapshot yet.');
  var old = requestSection_(JSON.parse(c.text));
  var made = [];
  var folderId = old && old.folderId && old.folderId !== cfg.rootFolderId ? old.folderId : null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'The server is busy. Please try again in a few seconds.');
  try {
    if (!folderId) {
      // A folder with "request" in its name that the last scan hasn't seen yet, else a new one.
      var found = listChildren_([cfg.rootFolderId], true).filter(function (f) {
        return f.name.charAt(0) !== '_' && sectionOf_(f.name, true) === REQUEST_SECTION;
      })[0];
      folderId = found ? found.id : DriveApp.getFolderById(cfg.rootFolderId).createFolder(REQUEST_FOLDER_NAME).getId();
      if (!found) made.push(REQUEST_FOLDER_NAME);
    }
    var have = {};
    listChildren_([folderId], true).forEach(function (f) { have[nameKey_(f.name)] = true; });
    var parent = null;
    names.forEach(function (n) {
      if (have[nameKey_(n)]) return;
      parent = parent || DriveApp.getFolderById(folderId);
      parent.createFolder(n);
      have[nameKey_(n)] = true;
      made.push(n);
    });
  } finally {
    lock.releaseLock();
  }
  if (made.length) log_('requestFolders', s.name, 'created: ' + made.join(', '));
  var res = saveRequestSection_(scanRequestFolder_(folderId, old && old.name));
  res.created = made;
  return res;
}

/** Put a scanned section into the cached snapshot; reply with it and the hashes before/after. */
function saveRequestSection_(sec) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'The server is busy. Please try again in a few seconds.');
  try {
    var snap = readFullSnapshot_();
    if (!snap) throw apiError_('notFound', 'No snapshot yet.');
    var before = snap.hash;
    patchSnapshotRequests_(snap, sec);
    return { ok: true, section: sec, hashFrom: before, hashTo: snap.hash };
  } finally {
    lock.releaseLock();
  }
}

var CHECK_COOLDOWN_SEC = 20;   // per session, so a stuck button can't flood Drive

/** "Check now": same scan as the 5-minute trigger, for any coordinator or the admin. */
function handleCheckNow_(body) {
  var s = checkToken_(body.token, 'staff');
  var cache = CacheService.getScriptCache();
  var key = 'chk:' + md5_(String(body.token));
  if (cache.get(key)) throw apiError_('tooSoon', 'You just checked. Please wait a few seconds, then try again.');
  cache.put(key, '1', CHECK_COOLDOWN_SEC);
  var res = runSnapshot_('check:' + s.name);
  if (!res.ok) {
    cache.remove(key); // a busy/failed attempt shouldn't count against the cooldown
    throw apiError_(res.error || 'server', res.message || 'Scan failed.');
  }
  return { ok: true, generatedAt: res.generatedAt, changed: !!res.changed, ms: res.ms };
}

function handleRefresh_(body) {
  var s = checkToken_(body.token, 'admin');
  var res = runSnapshot_('admin:' + s.name);
  if (!res.ok) throw apiError_(res.error || 'server', res.message || 'Scan failed.');
  return { ok: true, generatedAt: res.generatedAt, stats: res.stats, issueCount: res.issueCount, ms: res.ms };
}

function handleRebuild_(body) {
  var s = checkToken_(body.token, 'admin');
  var t0 = Date.now();
  var st = buildStructure();
  if (!st.ok) throw apiError_(st.error || 'server', st.message || 'Rebuild failed.');
  log_('rebuildStructure', 'admin:' + s.name, st.counts);
  var res = runSnapshot_('admin:' + s.name);
  if (!res.ok) throw apiError_(res.error || 'server', res.message || 'Scan failed after rebuild.');
  return { ok: true, counts: st.counts, issueCount: res.issueCount, generatedAt: res.generatedAt, ms: Date.now() - t0 };
}

function handleIssues_(body) {
  checkToken_(body.token, 'admin');
  var doc = readIssues_();
  var p = PropertiesService.getScriptProperties();
  return {
    ok: true,
    items: doc.items || [],
    lastScan: p.getProperty('LAST_SCAN'),
    lastScanMs: Number(p.getProperty('LAST_SCAN_MS') || 0),
    triggerActive: triggerActive_(),
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** json_, or the JSON text as it is for { raw } replies (a cached snapshot is not parsed and re-encoded). */
function reply_(res) {
  if (res && typeof res.raw === 'string') {
    return ContentService.createTextOutput(res.raw).setMimeType(ContentService.MimeType.JSON);
  }
  return json_(res);
}
