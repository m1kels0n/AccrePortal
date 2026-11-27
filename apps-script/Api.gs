/**
 * Api.gs: web app endpoints + viewer settings.
 * Deploy as: Web app · Execute as: Me · Who has access: Anyone.
 *
 * GET  ?action=ping
 * GET  ?action=snapshot&token=<token>[&since=<hash>]
 *        The admin and coordinators get the full snapshot, Reference folders included.
 *        Accreditors get only the areas the admin opened, without Drive folder links
 *        (error "noAccess" if the program is closed to them).
 * POST (body = JSON text, sent as text/plain to avoid a CORS preflight)
 *      { action: 'login', pin }                 (main program only)
 *      { action: 'logout', token }
 *      { action: 'saveKeywords', token, fileId, keywords }   (coordinator or admin)
 *      { action: 'checkNow', token }            (coordinator or admin: rescan Drive now)
 *      { action: 'refresh', token }             (admin)
 *      { action: 'rebuildStructure', token }    (admin)
 *      { action: 'issues', token }              (admin)
 *      { action: 'saveSettings', token, accreditorEnabled?, accreditorAreas?, watermark? }   (admin)
 *        With accreditor: '<name>' the change is that one accreditor's own setting for this program
 *        (reset: true removes it, back to the program-wide setting). No watermark per accreditor.
 *      { action: 'accreditors', token }         (admin, main program: names from the Access tab)
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
      return json_(snapshotFor_(session, p.since));
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
function snapshotFor_(session, since) {
  var c = readSnapshot_();
  if (!c) return { ok: false, error: 'notReady', message: 'No snapshot yet. Run AACCUP → Build snapshot now.' };
  var st = readSettings_();

  if (session.role !== 'accreditor') {
    // The admin also gets each accreditor's own settings (for the admin panel); coordinators don't.
    var shown = session.role === 'admin' ? adminSettings_(st) : st;
    if (since && c.meta && c.meta.hash === since) {
      return { ok: true, unchanged: true, hash: c.meta.hash, generatedAt: c.meta.generatedAt, settings: shown };
    }
    var full = JSON.parse(c.text); // Reference folders included: admin and coordinators see them in All files
    full.settings = shown;
    return full;
  }

  // This accreditor's own settings for the program if the admin set any, else the program-wide ones.
  var mine = settingsFor_(st, session.name);
  if (!mine.accreditorEnabled) throw apiError_('noAccess', 'This program is not open to accreditors.');
  var pub = { watermark: st.watermark };
  var hash = c.meta.hash + '.' + md5_(JSON.stringify(mine.accreditorAreas)).slice(0, 8);
  if (since && since === hash) {
    return { ok: true, unchanged: true, hash: hash, generatedAt: c.meta.generatedAt, settings: pub };
  }
  var snap = JSON.parse(c.text);
  var allowed = mine.accreditorAreas === 'ALL' ? null : toSet_(mine.accreditorAreas.map(normalizeAreaCode_));
  return {
    schema: snap.schema,
    program: { code: snap.program.code, name: snap.program.name },
    generatedAt: snap.generatedAt,
    hash: hash,
    looseFiles: (snap.looseFiles || []).map(viewerFile_),
    // Sections (Compliance Report, PPP, Actual Self-Survey Report) are opened and hidden like areas.
    sections: (snap.sections || []).filter(function (x) { return !allowed || allowed[normalizeAreaCode_(x.code)]; }).map(function (x) {
      return { code: x.code, name: x.name, files: x.files.map(viewerFile_),
               subfolders: (x.subfolders || []).map(function (s) { return typeof s === 'string' ? s : s.path; }) };
    }),
    areas: snap.areas.filter(function (a) { return !allowed || allowed[normalizeAreaCode_(a.code)]; }).map(viewerArea_),
    settings: pub,
  };
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

/** Accreditor copy of a file. A folder shortcut would preview as a browsable Drive folder (other areas, Drive links). */
function viewerFile_(f) {
  var o = { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, modified: f.modified,
            previewUrl: f.mimeType === FOLDER_MIME ? null : f.previewUrl, keywords: f.keywords || [] };
  if (f.subfolder) o.subfolder = f.subfolder;
  return o;
}

// ── Viewer settings (Config tab: accreditorEnabled, accreditorAreas, watermark) ──
function readSettings_() {
  var cache = CacheService.getScriptCache();
  var raw = cache.get('settings');
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* rebuild below */ } }
  var cfg = getConfig_();
  var flag = function (v) { return v === undefined || String(v).trim() === '' ? true : isTrue_(v); };
  var s = { accreditorEnabled: flag(cfg.accreditorEnabled), accreditorAreas: parseAreas_(cfg.accreditorAreas), watermark: flag(cfg.watermark) };
  cache.put('settings', JSON.stringify(s), 120);
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
  cache.put('overrides', JSON.stringify(list), 120);
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

/** Admin only, main program only: the accreditor names from the Access tab (never their PINs). */
function handleAccreditors_(body) {
  checkToken_(body.token, 'admin');
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
    var c = readSnapshot_();
    if (!c) throw apiError_('notFound', 'No snapshot yet.');
    var snap = JSON.parse(c.text);
    // Any file in the snapshot, Reference folders included (admin and coordinators both see them).
    if (!hasFile_(snap, fileId)) throw apiError_('notFound', 'File not found. It may have been moved or deleted. Reload the page.');
    upsertKeywords_(fileId, keywords, s.name);
    patchSnapshotKeywords_(snap, fileId, keywords);
  } finally {
    lock.releaseLock();
  }
  log_('keywords', s.name, fileId + ': ' + keywords.join(', '));
  return { ok: true, fileId: fileId, keywords: keywords, updatedAt: new Date().toISOString() };
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
