/**
 * Snapshot.gs: scans FILES ONLY inside the known folders (saved by ID in the Structure tab)
 * and writes snapshot.json + issues.json (private _system folder) and CacheService copies.
 *
 * Uses batched parent queries ("'a' in parents or 'b' in parents …", 40 IDs per query),
 * so a full scan is about 15–25 Drive API calls.
 */

var PARENT_BATCH = 40;
var CACHE_TTL = 21600;        // 6 h (CacheService maximum)
var CACHE_CHUNK = 30000;      // characters per cache value (stays < 100 KB even for 3-byte chars)
var MAX_MISSING_CHECKS = 60;

/** Time-driven trigger entry point (every 5 minutes). */
function buildSnapshot() {
  return runSnapshot_('trigger');
}

function runSnapshot_(source) {
  if (!acquireScan_()) return { ok: false, error: 'busy', message: 'A scan is already running. Try again in a minute.' };
  var t0 = Date.now();
  try {
    var res = scan_(source, t0);
    var props = PropertiesService.getScriptProperties();
    props.setProperty('LAST_SCAN', new Date().toISOString());
    props.setProperty('LAST_SCAN_MS', String(Date.now() - t0));
    res.ms = Date.now() - t0;
    return res;
  } catch (err) {
    var msg = String(err && err.message || err);
    console.error('Snapshot failed: ' + msg);
    log_('scanError', source, msg);
    return { ok: false, error: 'server', message: msg };
  } finally {
    releaseScan_();
  }
}

function scan_(source, t0) {
  var cfg = requireConfig_(['rootFolderId', 'snapshotFileId', 'issuesFileId']);
  var st = readStructure_();
  if (!st.rows.length) throw new Error('The Structure tab is empty. Run AACCUP → Build structure first.');
  var issues = [];
  var rowsOf = function (level) { return st.rows.filter(function (r) { return r.level === level; }); };

  // Naming issues recorded at build time
  st.rows.forEach(function (r) {
    if (r.status === 'badName') issues.push({ type: 'badFolderName', path: parentPath_(r), folderId: r.folderId, name: r.rawName });
    if (r.status === 'duplicateCode') issues.push({ type: 'duplicateCode', path: parentPath_(r), folderId: r.folderId, name: r.rawName });
  });

  // ── 1. Children of root + areas + parameters + S/I/O groups ──
  var containers = [cfg.rootFolderId].concat(st.rows.filter(function (r) { return r.level !== 'indicator'; }).map(function (r) { return r.folderId; }));
  var containerSet = toSet_(containers);
  var seenParent = {};   // folderId → parent it was found in
  var loose = {};        // container folderId → [file]
  listChildren_(containers, false).forEach(function (f) {
    var parent = firstIn_(f.parents, containerSet);
    if (f.mimeType === FOLDER_MIME) {
      seenParent[f.id] = parent;
      if (!st.allById[f.id] && f.name.charAt(0) !== '_' && f.id !== cfg.systemFolderId) {
        issues.push({ type: 'newFolder', path: containerPath_(parent, st, cfg), folderId: f.id, name: f.name, hint: 'Run Rebuild structure' });
      }
    } else {
      (loose[parent] = loose[parent] || []).push(toFile_(f));
      issues.push({ type: 'misplaced', path: containerPath_(parent, st, cfg), fileId: f.id, name: f.name });
    }
  });

  // ── 2. Missing or moved structure folders ──
  var checks = 0;
  st.rows.forEach(function (r) {
    var found = seenParent[r.folderId];
    if (found === r.parentFolderId) return;
    if (found) {
      issues.push({ type: 'movedFolder', path: r.path, folderId: r.folderId, nowIn: containerPath_(found, st, cfg) });
      return;
    }
    if (st.byId[r.parentFolderId] && seenParent[r.parentFolderId] === undefined && r.parentFolderId !== cfg.rootFolderId) return; // parent already reported
    if (checks++ >= MAX_MISSING_CHECKS) return;
    try {
      var g = Drive.Files.get(r.folderId, { fields: 'id,name,trashed,parents', supportsAllDrives: true });
      if (g.trashed) issues.push({ type: 'missingFolder', path: r.path, folderId: r.folderId, reason: 'trashed' });
      else issues.push({ type: 'movedFolder', path: r.path, folderId: r.folderId, nowIn: 'outside the program folder' });
    } catch (e) {
      issues.push({ type: 'missingFolder', path: r.path, folderId: r.folderId, reason: 'notFound' });
    }
  });

  // ── 3. Files in indicator folders (+ one level of subfolders) ──
  var indRows = rowsOf('indicator');
  var indSet = toSet_(indRows.map(function (r) { return r.folderId; }));
  var filesByInd = {};
  var subs = {};
  listChildren_(Object.keys(indSet), false).forEach(function (f) {
    var ind = firstIn_(f.parents, indSet);
    if (f.mimeType === FOLDER_MIME) subs[f.id] = { name: f.name, ind: ind };
    else (filesByInd[ind] = filesByInd[ind] || []).push(toFile_(f));
  });
  var subIds = Object.keys(subs);
  if (subIds.length) {
    var subSet = toSet_(subIds);
    listChildren_(subIds, false).forEach(function (f) {
      var sub = subs[firstIn_(f.parents, subSet)];
      if (!sub) return;
      if (f.mimeType === FOLDER_MIME) {
        issues.push({ type: 'deepFile', path: st.byId[sub.ind].path + ' > ' + sub.name + ' > ' + f.name, folderId: f.id, name: f.name, hint: 'Only 1 subfolder level is scanned' });
      } else {
        (filesByInd[sub.ind] = filesByInd[sub.ind] || []).push(toFile_(f, sub.name));
      }
    });
  }

  // ── 4. Assemble, merge keywords, write (short critical section) ──
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Could not get the lock to save the snapshot.');
  try {
    var kw = readKeywords_();
    var snap = assemble_(cfg, st, loose, filesByInd, kw);
    var issuesDoc = { generatedAt: snap.generatedAt, items: issues };
    var changed = saveSnapshot_(cfg, snap, issuesDoc);
    if (changed) log_('snapshot', source, snap.stats.files + ' files, ' + issues.length + ' issues, ' + (Date.now() - t0) + ' ms');
    return { ok: true, generatedAt: snap.generatedAt, stats: snap.stats, issueCount: issues.length, changed: changed };
  } finally {
    lock.releaseLock();
  }
}

function assemble_(cfg, st, loose, filesByInd, kw) {
  var bySort = function (a, b) { return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0; };
  var group = function (level, key) {
    var m = {};
    st.rows.filter(function (r) { return r.level === level; }).sort(bySort).forEach(function (r) {
      (m[r[key]] = m[r[key]] || []).push(r);
    });
    return m;
  };
  var paramsByArea = group('parameter', 'parentFolderId');
  var groupsByParam = group('group', 'parentFolderId');
  var indsByParam = group('indicator', 'paramFolderId');
  var withKw = function (files) {
    return sortFiles_(files || []).map(function (f) { f.keywords = kw[f.id] || []; return f; });
  };
  var stats = { areas: 0, indicators: 0, indicatorsWithFiles: 0, files: 0 };

  var areas = st.rows.filter(function (r) { return r.level === 'area'; }).sort(bySort).map(function (a) {
    stats.areas++;
    return {
      code: a.code, name: a.name, folderId: a.folderId,
      looseFiles: withKw(loose[a.folderId]),
      parameters: (paramsByArea[a.folderId] || []).map(function (p) {
        var paramLoose = (loose[p.folderId] || []).slice();
        (groupsByParam[p.folderId] || []).forEach(function (g) { paramLoose = paramLoose.concat(loose[g.folderId] || []); });
        return {
          code: p.code, name: p.name, folderId: p.folderId,
          looseFiles: withKw(paramLoose),
          indicators: (indsByParam[p.folderId] || []).map(function (i) {
            var files = withKw(filesByInd[i.folderId]);
            stats.indicators++;
            stats.files += files.length;
            if (files.length) stats.indicatorsWithFiles++;
            var t = i.code.match(/^([SIO])\.\d/);
            return { code: i.code, type: t ? t[1] : null, text: i.text, folderId: i.folderId, files: files };
          }),
        };
      }),
    };
  });

  var body = {
    schema: 1,
    program: {
      code: cfg.programCode || 'p1',
      name: cfg.programName || 'Program',
      rootFolderUrl: 'https://drive.google.com/drive/folders/' + cfg.rootFolderId,
    },
    looseFiles: withKw(loose[cfg.rootFolderId]),
    areas: areas,
  };
  var hash = md5_(JSON.stringify(body));
  return {
    schema: 1,
    program: body.program,
    generatedAt: new Date().toISOString(),
    hash: hash,
    stats: stats,
    looseFiles: body.looseFiles,
    areas: areas,
  };
}

/** Writes Drive files only when content changed; always refreshes the cache. Returns changed. */
function saveSnapshot_(cfg, snap, issuesDoc) {
  var props = PropertiesService.getScriptProperties();
  var text = JSON.stringify(snap);
  var changed = snap.hash !== props.getProperty('SNAP_HASH');
  if (changed) {
    DriveApp.getFileById(cfg.snapshotFileId).setContent(text);
    props.setProperty('SNAP_HASH', snap.hash);
  }
  cachePutChunked_('snap', text, { hash: snap.hash, generatedAt: snap.generatedAt });

  var issuesText = JSON.stringify(issuesDoc);
  var issuesHash = md5_(JSON.stringify(issuesDoc.items));
  if (issuesHash !== props.getProperty('ISSUES_HASH')) {
    DriveApp.getFileById(cfg.issuesFileId).setContent(issuesText);
    props.setProperty('ISSUES_HASH', issuesHash);
  }
  cachePutChunked_('issues', issuesText, { hash: issuesHash, generatedAt: issuesDoc.generatedAt });
  return changed;
}

/** Returns { text, meta: { hash, generatedAt } } or null. Cache first, then the Drive file. */
function readSnapshot_() {
  var c = cacheGetChunked_('snap');
  if (c) return c;
  var cfg = getConfig_();
  if (!cfg.snapshotFileId) return null;
  var text = DriveApp.getFileById(cfg.snapshotFileId).getBlob().getDataAsString('UTF-8');
  if (!text || text.length < 10) return null;
  var snap = JSON.parse(text);
  var meta = { hash: snap.hash, generatedAt: snap.generatedAt };
  cachePutChunked_('snap', text, meta);
  return { text: text, meta: meta };
}

function readIssues_() {
  var c = cacheGetChunked_('issues');
  if (c) return JSON.parse(c.text);
  var cfg = getConfig_();
  if (!cfg.issuesFileId) return { items: [] };
  var text = DriveApp.getFileById(cfg.issuesFileId).getBlob().getDataAsString('UTF-8');
  try { var doc = JSON.parse(text); return doc.items ? doc : { items: [] }; } catch (e) { return { items: [] }; }
}

/**
 * After a keyword save: update the keywords of fileId in the cached snapshot
 * (the caller holds the script lock). The next scan rewrites the Drive file.
 */
function patchSnapshotKeywords_(snap, fileId, keywords) {
  eachFileInSnapshot_(snap, function (f) { if (f.id === fileId) f.keywords = keywords; });
  var body = { schema: 1, program: snap.program, looseFiles: snap.looseFiles, areas: snap.areas };
  snap.hash = md5_(JSON.stringify(body));
  cachePutChunked_('snap', JSON.stringify(snap), { hash: snap.hash, generatedAt: snap.generatedAt });
  PropertiesService.getScriptProperties().deleteProperty('SNAP_HASH');
}

/** Area codes in which a file id appears (shortcuts can make it appear more than once). */
function areasOfFile_(snap, fileId) {
  var out = [];
  eachFileInSnapshot_(snap, function (f, area) { if (f.id === fileId && area && out.indexOf(area.code) === -1) out.push(area.code); });
  return out;
}

function eachFileInSnapshot_(snap, fn) {
  (snap.looseFiles || []).forEach(function (f) { fn(f, null); });
  (snap.areas || []).forEach(function (a) {
    (a.looseFiles || []).forEach(function (f) { fn(f, a); });
    a.parameters.forEach(function (p) {
      (p.looseFiles || []).forEach(function (f) { fn(f, a); });
      p.indicators.forEach(function (i) { i.files.forEach(function (f) { fn(f, a); }); });
    });
  });
}

// ── Keywords tab ─────────────────────────────────────────────
function readKeywords_() {
  var map = {};
  readTable_('Keywords').forEach(function (r) {
    var id = String(r.fileId || '').trim();
    if (id) map[id] = cleanKeywords_(r.keywords);
  });
  return map;
}

function upsertKeywords_(fileId, keywords, user) {
  var sh = sheet_('Keywords');
  var n = Math.max(sh.getLastRow() - 1, 0);
  var ids = n ? sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
  var i = ids.indexOf(fileId);
  if (!keywords.length) { if (i !== -1) sh.deleteRow(i + 2); return; }
  var values = [[fileId, keywords.join(', '), user, new Date()]];
  if (i === -1) sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues(values);
  else sh.getRange(i + 2, 1, 1, 4).setValues(values);
}

function cleanKeywords_(input) {
  var seen = {};
  var out = [];
  String(input || '').split(/[,;\n]/).forEach(function (raw) {
    var k = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
    var key = k.toLowerCase();
    if (k && !seen[key] && out.length < 20) { seen[key] = true; out.push(k); }
  });
  return out;
}

// ── Drive helpers ────────────────────────────────────────────
/** List the children of many folders with batched "in parents" queries. */
function listChildren_(parentIds, foldersOnly, extraFields) {
  var out = [];
  if (!parentIds.length) return out;
  var cfg = getConfig_();
  var fields = 'nextPageToken,files(id,name,mimeType,parents,size,modifiedTime,webViewLink,shortcutDetails' +
               (extraFields ? ',' + extraFields : '') + ')';
  for (var i = 0; i < parentIds.length; i += PARENT_BATCH) {
    var chunk = parentIds.slice(i, i + PARENT_BATCH);
    var q = '(' + chunk.map(function (id) { return "'" + id + "' in parents"; }).join(' or ') + ') and trashed = false';
    if (foldersOnly) q += " and mimeType = '" + FOLDER_MIME + "'";
    var pageToken = null;
    do {
      var params = { q: q, fields: fields, pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true };
      if (cfg.driveId) { params.corpora = 'drive'; params.driveId = cfg.driveId; }
      if (pageToken) params.pageToken = pageToken;
      var res = withRetry_(function () { return Drive.Files.list(params); });
      (res.files || []).forEach(function (f) { out.push(f); });
      pageToken = res.nextPageToken;
    } while (pageToken);
  }
  return out;
}

function withRetry_(fn) {
  for (var attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 3) throw e;
      Utilities.sleep(1000 * Math.pow(2, attempt));
    }
  }
}

function toFile_(f, subfolder) {
  var id = f.id;
  var mime = f.mimeType;
  var shortcut = false;
  if (mime === SHORTCUT_MIME && f.shortcutDetails) {
    id = f.shortcutDetails.targetId;
    mime = f.shortcutDetails.targetMimeType || '';
    shortcut = true;
  }
  var o = {
    id: id,
    name: f.name,
    mimeType: mime,
    size: f.size ? Number(f.size) : null,
    modified: f.modifiedTime || null,
    viewUrl: (!shortcut && f.webViewLink) || viewUrl_(id, mime),
    previewUrl: previewUrl_(id, mime),
    keywords: [],
  };
  if (subfolder) o.subfolder = subfolder;
  if (shortcut) o.shortcut = true;
  return o;
}

function viewUrl_(id, mime) {
  switch (mime) {
    case FOLDER_MIME: return 'https://drive.google.com/drive/folders/' + id;
    case 'application/vnd.google-apps.document': return 'https://docs.google.com/document/d/' + id + '/edit?usp=sharing';
    case 'application/vnd.google-apps.spreadsheet': return 'https://docs.google.com/spreadsheets/d/' + id + '/edit?usp=sharing';
    case 'application/vnd.google-apps.presentation': return 'https://docs.google.com/presentation/d/' + id + '/edit?usp=sharing';
    case 'application/vnd.google-apps.form': return 'https://docs.google.com/forms/d/' + id + '/viewform';
    default: return 'https://drive.google.com/file/d/' + id + '/view';
  }
}

function previewUrl_(id, mime) {
  switch (mime) {
    case FOLDER_MIME: return 'https://drive.google.com/embeddedfolderview?id=' + id + '#list';
    case 'application/vnd.google-apps.document': return 'https://docs.google.com/document/d/' + id + '/preview';
    case 'application/vnd.google-apps.spreadsheet': return 'https://docs.google.com/spreadsheets/d/' + id + '/preview';
    case 'application/vnd.google-apps.presentation': return 'https://docs.google.com/presentation/d/' + id + '/preview';
  }
  if (String(mime).indexOf('application/vnd.google-apps.') === 0) return null; // forms, sites, maps…
  return 'https://drive.google.com/file/d/' + id + '/preview';
}

function sortFiles_(files) {
  return files.sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  });
}

function firstIn_(parents, set) {
  parents = parents || [];
  for (var i = 0; i < parents.length; i++) if (set[parents[i]]) return parents[i];
  return parents[0] || '';
}

function parentPath_(r) {
  return r.path.indexOf(' > ') === -1 ? '(program root)' : r.path.replace(/ > [^>]*$/, '');
}

function containerPath_(folderId, st, cfg) {
  if (folderId === cfg.rootFolderId) return '(program root)';
  var r = st.byId[folderId] || st.allById[folderId];
  return r ? r.path : folderId;
}

// ── Scan mutex + chunked cache ───────────────────────────────
function acquireScan_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return false;
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('scanRunning')) return false;
    cache.put('scanRunning', String(Date.now()), 330); // auto-expires if a run dies
    return true;
  } finally {
    lock.releaseLock();
  }
}

function releaseScan_() {
  CacheService.getScriptCache().remove('scanRunning');
}

function cachePutChunked_(key, text, meta) {
  var cache = CacheService.getScriptCache();
  var version = Date.now().toString(36);
  var n = Math.ceil(text.length / CACHE_CHUNK);
  var values = {};
  for (var i = 0; i < n; i++) values[key + ':' + version + ':' + i] = text.substr(i * CACHE_CHUNK, CACHE_CHUNK);
  values[key + ':meta'] = JSON.stringify({ v: version, n: n, hash: meta.hash, generatedAt: meta.generatedAt });
  try {
    cache.putAll(values, CACHE_TTL);
  } catch (e) {
    console.warn('Cache write failed (the Drive file will be used): ' + e);
  }
}

function cacheGetChunked_(key) {
  var cache = CacheService.getScriptCache();
  var rawMeta = cache.get(key + ':meta');
  if (!rawMeta) return null;
  var meta = JSON.parse(rawMeta);
  var keys = [];
  for (var i = 0; i < meta.n; i++) keys.push(key + ':' + meta.v + ':' + i);
  var got = cache.getAll(keys);
  var parts = [];
  for (var j = 0; j < keys.length; j++) {
    if (got[keys[j]] === undefined || got[keys[j]] === null) return null;
    parts.push(got[keys[j]]);
  }
  return { text: parts.join(''), meta: meta };
}
