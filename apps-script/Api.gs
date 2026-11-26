/**
 * Api.gs: web app endpoints + viewer settings.
 * Deploy as: Web app · Execute as: Me · Who has access: Anyone.
 *
 * GET  ?action=ping
 * GET  ?action=snapshot&token=<token>[&since=<hash>]
 *        Coordinators/admin get the full snapshot. Accreditors get only the areas the admin
 *        opened, without Drive folder links (error "noAccess" if the program is closed to them).
 * POST (body = JSON text, sent as text/plain to avoid a CORS preflight)
 *      { action: 'login', pin }                 (main program only)
 *      { action: 'logout', token }
 *      { action: 'saveKeywords', token, fileId, keywords }   (coordinator or admin)
 *      { action: 'checkNow', token }            (coordinator or admin: rescan Drive now)
 *      { action: 'refresh', token }             (admin)
 *      { action: 'rebuildStructure', token }    (admin)
 *      { action: 'issues', token }              (admin)
 *      { action: 'saveSettings', token, accreditorEnabled?, accreditorAreas?, watermark? }   (admin)
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
    if (since && c.meta && c.meta.hash === since) {
      return { ok: true, unchanged: true, hash: c.meta.hash, generatedAt: c.meta.generatedAt, settings: st };
    }
    var full = JSON.parse(c.text);
    full.settings = st;
    return full;
  }

  if (!st.accreditorEnabled) throw apiError_('noAccess', 'This program is not open to accreditors.');
  var pub = { watermark: st.watermark };
  var hash = c.meta.hash + '.' + md5_(JSON.stringify(st.accreditorAreas)).slice(0, 8);
  if (since && since === hash) {
    return { ok: true, unchanged: true, hash: hash, generatedAt: c.meta.generatedAt, settings: pub };
  }
  var snap = JSON.parse(c.text);
  var allowed = st.accreditorAreas === 'ALL' ? null : toSet_(st.accreditorAreas.map(normalizeAreaCode_));
  return {
    schema: snap.schema,
    program: { code: snap.program.code, name: snap.program.name },
    generatedAt: snap.generatedAt,
    hash: hash,
    looseFiles: (snap.looseFiles || []).map(viewerFile_),
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
  var areasRaw = String(cfg.accreditorAreas || '').trim();
  var areas = /^(all)?$/i.test(areasRaw) ? 'ALL'
    : /^none$/i.test(areasRaw) ? []
    : areasRaw.split(/[,;\s]+/).map(normalizeAreaCode_).filter(Boolean);
  var flag = function (v) { return v === undefined || String(v).trim() === '' ? true : isTrue_(v); };
  var s = { accreditorEnabled: flag(cfg.accreditorEnabled), accreditorAreas: areas, watermark: flag(cfg.watermark) };
  cache.put('settings', JSON.stringify(s), 120);
  return s;
}

function handleSaveSettings_(body) {
  var s = checkToken_(body.token, 'admin');
  if (body.accreditorEnabled !== undefined) setConfig_('accreditorEnabled', body.accreditorEnabled ? 'TRUE' : 'FALSE');
  if (body.accreditorAreas !== undefined) {
    var a = body.accreditorAreas;
    var v;
    if (a === 'ALL') v = 'ALL';
    else if (Object.prototype.toString.call(a) === '[object Array]') {
      // Store each area's real code from the current snapshot (key → code); without one,
      // keep plain codes. Separators are refused because readSettings_ splits on them.
      var real = null;
      try {
        var c = readSnapshot_();
        if (c) {
          real = {};
          (JSON.parse(c.text).areas || []).forEach(function (ar) { real[normalizeAreaCode_(ar.code)] = String(ar.code); });
        }
      } catch (e) { real = null; }
      var seen = {};
      v = a.map(function (x) {
        if (real) return real[normalizeAreaCode_(x)] || '';
        x = String(x === null || x === undefined ? '' : x).trim();
        return /^[A-Za-z0-9.\-]{1,48}$/.test(x) ? x : '';
      }).filter(function (x) {
        var k = normalizeAreaCode_(x);
        if (!x || /[,;\s]/.test(x) || seen[k]) return false;
        seen[k] = true;
        return true;
      }).join(', ') || 'NONE';
    } else {
      throw apiError_('invalid', 'Bad area list.');
    }
    setConfig_('accreditorAreas', v);
  }
  if (body.watermark !== undefined) setConfig_('watermark', body.watermark ? 'TRUE' : 'FALSE');
  CacheService.getScriptCache().remove('settings');
  var st = readSettings_();
  log_('settings', 'admin:' + s.name, JSON.stringify(st));
  return { ok: true, settings: st };
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
