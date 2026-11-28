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

  // ── 1. Children of root + areas + parameters + S/I/O groups (sections are scanned in step 3) ──
  var containers = [cfg.rootFolderId].concat(st.rows.filter(function (r) { return r.level !== 'indicator' && r.level !== 'section'; }).map(function (r) { return r.folderId; }));
  var containerSet = toSet_(containers);
  var seenParent = {};   // folderId → parent it was found in
  var loose = {};        // container folderId → [file]
  var refs = [];         // Reference folders: shortcuts to folders at the program root → [{ name, folderId }]
  // Section codes the Structure tab already has (hidden ones too, so hiding one is respected).
  var knownSections = {};
  Object.keys(st.allById).forEach(function (id) { if (st.allById[id].level === 'section') knownSections[st.allById[id].code] = true; });
  listChildren_(containers, false).forEach(function (f) {
    var parent = firstIn_(f.parents, containerSet);
    if (f.mimeType === FOLDER_MIME) {
      seenParent[f.id] = parent;
      if (!st.allById[f.id] && f.name.charAt(0) !== '_' && f.id !== cfg.systemFolderId) {
        // A new Compliance Report / PPP / Actual Self-Survey Report folder at the root is used
        // right away, without Rebuild structure (scanned in step 3 like a known section).
        var sc = parent === cfg.rootFolderId ? sectionOf_(f.name, true) : '';
        if (sc && !knownSections[sc]) {
          knownSections[sc] = true;
          var row = { level: 'section', code: sc, name: SECTIONS[sc].name, text: '', folderId: f.id, parentFolderId: parent,
                      areaCode: '', parameterCode: '', sortKey: '0-' + SECTIONS[sc].order, path: SECTIONS[sc].name,
                      status: 'ok', rawName: f.name, hidden: false };
          st.rows.push(row);
          st.byId[f.id] = row;
          return;
        }
        issues.push({ type: 'newFolder', path: containerPath_(parent, st, cfg), folderId: f.id, name: f.name, hint: 'Run Rebuild structure' });
      }
    } else if (parent === cfg.rootFolderId && f.mimeType === SHORTCUT_MIME && f.shortcutDetails &&
               f.shortcutDetails.targetMimeType === FOLDER_MIME) {
      // A shortcut to a folder at the program root is a Reference folder: scanned with its
      // subfolders in step 3, shown to the admin and coordinators (All files only), not counted as evidence.
      var target = f.shortcutDetails.targetId;
      if (!refs.some(function (r) { return r.folderId === target; })) refs.push({ name: f.name, folderId: target });
    } else {
      // Not an issue: the site lists these as "General documents" of that area / parameter / program.
      (loose[parent] = loose[parent] || []).push(toFile_(f));
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

  // ── 3. Files in indicator and section folders, plus every level of subfolders inside them ──
  // A file in a subfolder is listed under its indicator, labeled with the subfolder path
  // (e.g. "I.1.6.1. Participative planning › I.1.6.1.3. Students"). One batched query per level.
  var MAX_SUB_DEPTH = 6;
  // Reference folders are often old archives with deep folders: practically every
  // level is scanned (20 is only a safety cap), and nothing deeper is reported as an issue.
  var REF_MAX_DEPTH = 20;
  var indRows = rowsOf('indicator').concat(rowsOf('section'));
  var indSet = toSet_(indRows.map(function (r) { return r.folderId; }));
  var filesByInd = {};
  var subsByInd = {};   // indicator folderId -> [{ path, id }] for every subfolder inside it, empty ones too
  // folderId -> { ind: indicator folderId, label: subfolder path ('' for the indicator itself), max: depth limit, ref }
  var level = {};
  Object.keys(indSet).forEach(function (id) { level[id] = { ind: id, label: '', max: MAX_SUB_DEPTH, ref: false }; });
  // Reference folders are scanned the same way, in the same batched queries.
  refs.forEach(function (r) {
    if (!level[r.folderId]) level[r.folderId] = { ind: r.folderId, label: '', max: REF_MAX_DEPTH, ref: true };
  });
  for (var depth = 0; Object.keys(level).length && depth <= REF_MAX_DEPTH; depth++) {
    var levelSet = toSet_(Object.keys(level));
    var next = {};
    listChildren_(Object.keys(level), false).forEach(function (f) {
      var parent = level[firstIn_(f.parents, levelSet)];
      if (!parent) return;
      if (f.mimeType !== FOLDER_MIME) {
        (filesByInd[parent.ind] = filesByInd[parent.ind] || []).push(toFile_(f, parent.label || undefined));
      } else if (depth < parent.max) {
        var label = parent.label ? parent.label + ' › ' + f.name : f.name;
        next[f.id] = { ind: parent.ind, label: label, max: parent.max, ref: parent.ref };
        (subsByInd[parent.ind] = subsByInd[parent.ind] || []).push({ path: label, id: f.id });
      } else if (!parent.ref) {
        issues.push({ type: 'deepFile', path: st.byId[parent.ind].path + ' > ' + parent.label + ' > ' + f.name, folderId: f.id, name: f.name, hint: 'Only ' + MAX_SUB_DEPTH + ' subfolder levels are scanned' });
      }
    });
    level = next;
  }

  // ── 4. Assemble, merge keywords, write (short critical section) ──
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Could not get the lock to save the snapshot.');
  try {
    var kw = readKeywords_();
    var snap = assemble_(cfg, st, loose, filesByInd, kw, subsByInd, refs, readRequests_());
    var issuesDoc = { generatedAt: snap.generatedAt, items: issues };
    var changed = saveSnapshot_(cfg, snap, issuesDoc);
    if (changed) log_('snapshot', source, snap.stats.files + ' files, ' + issues.length + ' issues, ' + (Date.now() - t0) + ' ms');
    return { ok: true, generatedAt: snap.generatedAt, stats: snap.stats, issueCount: issues.length, changed: changed };
  } finally {
    lock.releaseLock();
  }
}

function assemble_(cfg, st, loose, filesByInd, kw, subsByInd, refs, req) {
  subsByInd = subsByInd || {};
  req = req || {};
  var bySub = function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1; };
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
            var out = { code: i.code, type: t ? t[1] : null, text: i.text, folderId: i.folderId, files: files };
            // Sorted so the snapshot hash doesn't change just because Drive listed folders in another order.
            if (subsByInd[i.folderId]) out.subfolders = subsByInd[i.folderId].slice().sort(bySub);
            return out;
          }),
        };
      }),
    };
  });

  // Sections: Compliance Report, PPP, Actual Self-Survey Report. A section is its folder, and/or
  // files at the program root named after it (e.g. one "Compliance Report.pdf" next to the areas).
  var secByCode = {};
  st.rows.filter(function (r) { return r.level === 'section'; }).sort(bySort).forEach(function (r) {
    var sec = { code: r.code, name: r.name, folderId: r.folderId, files: (filesByInd[r.folderId] || []).slice() };
    if (subsByInd[r.folderId]) sec.subfolders = subsByInd[r.folderId].slice().sort(bySub);
    if (!secByCode[r.code]) secByCode[r.code] = sec;
  });
  var rootLoose = [];
  (loose[cfg.rootFolderId] || []).forEach(function (f) {
    var code = sectionOf_(f.name);
    if (!code) { rootLoose.push(f); return; }
    if (!secByCode[code]) secByCode[code] = { code: code, name: SECTIONS[code].name, folderId: cfg.rootFolderId, files: [] };
    secByCode[code].files.push(f);
  });
  var sections = Object.keys(SECTIONS).filter(function (c) { return secByCode[c]; }).map(function (c) {
    var sec = secByCode[c];
    sec.files = withKw(sec.files);
    // Requested Documents: the accreditors each file is for ([] = nobody yet, so no accreditor sees it).
    if (c === REQUEST_SECTION) sec.files.forEach(function (f) { f.for = req[f.id] || []; });
    stats.files += sec.files.length;
    return sec;
  });

  // Reference folders (admin and coordinators, never accreditors; see snapshotFor_): not counted in stats. Sorted by name so the
  // hash doesn't change just because Drive listed the shortcuts in another order.
  var reference = (refs || []).slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; })
    .map(function (r) {
      var ref = { name: r.name, folderId: r.folderId, files: withKw(filesByInd[r.folderId]) };
      if (subsByInd[r.folderId]) ref.subfolders = subsByInd[r.folderId].slice().sort(bySub);
      return ref;
    });

  var snap = {
    schema: 1,
    program: {
      code: cfg.programCode || 'p1',
      name: cfg.programName || 'Program',
      rootFolderUrl: 'https://drive.google.com/drive/folders/' + cfg.rootFolderId,
    },
    generatedAt: new Date().toISOString(),
    hash: '',
    refHash: '',
    stats: stats,
    looseFiles: withKw(rootLoose),
    sections: sections,
    areas: areas,
    reference: reference,
  };
  setSnapshotHashes_(snap);
  return snap;
}

/**
 * snap.hash covers everything except the Reference folders; snap.refHash covers only them.
 * So a change in a Reference folder (seen only on the All files page) doesn't make every
 * accreditor download the file list again, and vice versa.
 */
function setSnapshotHashes_(snap) {
  snap.hash = md5_(JSON.stringify({ schema: 1, program: snap.program, looseFiles: snap.looseFiles,
                                    sections: snap.sections || [], areas: snap.areas }));
  snap.refHash = md5_(JSON.stringify(snap.reference || [])).slice(0, 12);
}

/**
 * Writes the Drive files only when their content changed. The cache is rewritten only when the
 * content changed (or its copy is getting old); otherwise just the scan time in its meta is updated,
 * instead of re-sending the whole file list to the cache every 5 minutes. Returns changed.
 */
function saveSnapshot_(cfg, snap, issuesDoc) {
  var props = PropertiesService.getScriptProperties();
  var key = snap.hash + '|' + snap.refHash;
  var changed = key !== props.getProperty('SNAP_HASH');
  if (changed) {
    DriveApp.getFileById(cfg.snapshotFileId).setContent(JSON.stringify(snap));
    props.setProperty('SNAP_HASH', key);
  }
  var m = snapMeta_();
  if (m && m.hash === snap.hash && m.refHash === snap.refHash && cacheFresh_(m)) {
    cacheTouchMeta_('snap', m, { generatedAt: snap.generatedAt });
  } else {
    cacheSnapshot_(snap);
  }

  var issuesText = JSON.stringify(issuesDoc);
  var issuesHash = md5_(JSON.stringify(issuesDoc.items));
  if (issuesHash !== props.getProperty('ISSUES_HASH')) {
    DriveApp.getFileById(cfg.issuesFileId).setContent(issuesText);
    props.setProperty('ISSUES_HASH', issuesHash);
  }
  var im = cacheMeta_('issues');
  if (!(im && im.hash === issuesHash && cacheFresh_(im))) {
    cachePutChunked_('issues', issuesText, { hash: issuesHash, generatedAt: issuesDoc.generatedAt });
  }
  return changed;
}

// ── Cached snapshot, in two parts ────────────────────────────
// 'snap': the snapshot WITHOUT the Reference folders (plus refHash and refCount): what every
//         page needs, and all accreditors ever get.
// 'ref':  the Reference folders only (often large old archives): loaded by the All files page.
// The Drive file snapshot.json keeps everything in one piece (backup, Plan B).
var SNAP_FMT = 2;
var CACHE_REWRITE_MS = 5 * 3600 * 1000; // rewrite the cached copy before its 6 h lifetime runs out

/** Meta of the cached snapshot { hash, refHash, refCount, generatedAt, v, n, at, f } or null. Reads no chunks. */
function snapMeta_() {
  var m = cacheMeta_('snap');
  return m && m.f === SNAP_FMT && m.hash ? m : null;
}

/** Split a full snapshot (Reference folders included) into the two cached parts and cache them. */
function cacheSnapshot_(snap) {
  var reference = snap.reference || [];
  var refText = JSON.stringify(reference);
  var refHash = snap.refHash || md5_(refText).slice(0, 12);
  var main = {};
  Object.keys(snap).forEach(function (k) { if (k !== 'reference') main[k] = snap[k]; });
  main.refHash = refHash;
  main.refCount = reference.length;
  var mainText = JSON.stringify(main);
  var meta = { f: SNAP_FMT, hash: snap.hash, refHash: refHash, refCount: reference.length, generatedAt: snap.generatedAt };
  // The Reference part first: a reader that sees the new 'snap' meta then finds the matching 'ref'.
  // Unchanged and still fresh: kept as it is (it is usually the biggest part).
  var oldRm = cacheMeta_('ref');
  var rm = oldRm && oldRm.hash === refHash && cacheFresh_(oldRm) ? oldRm : cachePutChunked_('ref', refText, { hash: refHash });
  var sm = rm ? cachePutChunked_('snap', mainText, meta) : null;
  if (!sm) { try { CacheService.getScriptCache().remove('snap:meta'); } catch (e) { /* the Drive file is used */ } }
  return { mainText: mainText, refText: refText, meta: meta };
}

/** The Drive file, split and cached again. Null when there is no snapshot yet. */
function loadSnapshotFile_() {
  var cfg = getConfig_();
  if (!cfg.snapshotFileId) return null;
  var text = DriveApp.getFileById(cfg.snapshotFileId).getBlob().getDataAsString('UTF-8');
  if (!text || text.length < 10) return null;
  var snap = JSON.parse(text);
  if (!snap || !snap.areas) return null;
  return cacheSnapshot_(snap);
}

/** The snapshot without Reference folders: { text, meta } or null. Cache first, then the Drive file. */
function readSnapshot_() {
  var m = snapMeta_();
  var text = m ? cacheGetChunks_('snap', m) : null;
  if (text !== null) return { text: text, meta: m };
  var c = loadSnapshotFile_();
  return c ? { text: c.mainText, meta: c.meta } : null;
}

/** The Reference folders: { text (a JSON array), refHash } or null. */
function readReference_() {
  var m = snapMeta_();
  var rm = m ? cacheMeta_('ref') : null;
  var text = rm && rm.hash === m.refHash ? cacheGetChunks_('ref', rm) : null;
  if (text !== null) return { text: text, refHash: m.refHash };
  var c = loadSnapshotFile_();
  return c ? { text: c.refText, refHash: c.meta.refHash } : null;
}

/** The whole snapshot as an object, Reference folders included (keyword saves). Null if none yet. */
function readFullSnapshot_() {
  var c = readSnapshot_();
  if (!c) return null;
  var snap = JSON.parse(c.text);
  var r = readReference_();
  snap.reference = r ? JSON.parse(r.text) : [];
  snap.generatedAt = c.meta.generatedAt || snap.generatedAt;
  delete snap.refCount;
  return snap;
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
 * After a keyword save: update the keywords of fileId in the cached snapshot (a full one, from
 * readFullSnapshot_; the caller holds the script lock). The next scan rewrites the Drive file.
 */
function patchSnapshotKeywords_(snap, fileId, keywords) {
  eachFileInSnapshot_(snap, function (f) { if (f.id === fileId) f.keywords = keywords; });
  setSnapshotHashes_(snap);
  cacheSnapshot_(snap);
  PropertiesService.getScriptProperties().deleteProperty('SNAP_HASH');
}

/** Is this file id anywhere in the snapshot (program root files and Reference folders included)? */
function hasFile_(snap, fileId) {
  var found = false;
  eachFileInSnapshot_(snap, function (f) { if (f.id === fileId) found = true; });
  return found;
}

/** fn(file, area) for every file, Reference folders included. */
function eachFileInSnapshot_(snap, fn) {
  (snap.reference || []).forEach(function (r) { (r.files || []).forEach(function (f) { fn(f, null); }); });
  (snap.looseFiles || []).forEach(function (f) { fn(f, null); });
  (snap.sections || []).forEach(function (s) { s.files.forEach(function (f) { fn(f, null); }); });
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
  var row = i === -1 ? sh.getLastRow() + 1 : i + 2;
  // Plain text, so Sheets never turns keywords into dates, numbers or formulas.
  sh.getRange(row, 1, 1, 2).setNumberFormat('@');
  sh.getRange(row, 1, 1, 4).setValues(values);
}

function cleanKeywords_(input) {
  var seen = {};
  var out = [];
  String(input || '').split(/[,;\n]/).forEach(function (raw) {
    var k = raw.replace(/\s+/g, ' ').replace(/^[\s=+\-@]+/, '').trim().slice(0, 40); // no formula starts
    var key = k.toLowerCase();
    if (k && !seen[key] && out.length < 20) { seen[key] = true; out.push(k); }
  });
  return out;
}

// ── Requests tab (who each Requested Documents file is for) ──
// One row per file: fileId · accreditors (names from the main program's Access tab, comma
// separated) · updatedBy · updatedAt. Created by the first save; missing tab = nobody assigned.
var REQUESTS_TAB = 'Requests';

/** { fileId: [names] } */
function readRequests_() {
  var map = {};
  var sh = ss_().getSheetByName(REQUESTS_TAB);
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var id = String(r[0] || '').trim();
    if (id) map[id] = cleanNames_(String(r[1] || '').split(','));
  });
  return map;
}

/** Accreditor names: trimmed, no formula starts, no commas (the list separator), no duplicates. */
function cleanNames_(input) {
  var seen = {};
  var out = [];
  [].concat(input || []).forEach(function (raw) {
    var n = String(raw === null || raw === undefined ? '' : raw).replace(/\s+/g, ' ').trim();
    var key = n.toLowerCase();
    if (!n || n.length > 100 || /^[=+\-@]/.test(n) || /[,;]/.test(n) || seen[key] || out.length >= 50) return;
    seen[key] = true;
    out.push(n);
  });
  return out;
}

/** The caller holds the script lock. An empty list removes the row. */
function upsertRequest_(fileId, names, user) {
  var ss = ss_();
  var sh = ss.getSheetByName(REQUESTS_TAB);
  if (!sh) {
    if (!names.length) return;
    sh = ss.insertSheet(REQUESTS_TAB);
    sh.getRange(1, 1, 1, 4).setValues([SHEET_HEADERS[REQUESTS_TAB]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  var n = Math.max(sh.getLastRow() - 1, 0);
  var ids = n ? sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
  var i = ids.indexOf(fileId);
  if (!names.length) { if (i !== -1) sh.deleteRow(i + 2); return; }
  var row = i === -1 ? sh.getLastRow() + 1 : i + 2;
  sh.getRange(row, 1, 1, 2).setNumberFormat('@');
  sh.getRange(row, 1, 1, 4).setValues([[fileId, names.join(', '), user, new Date()]]);
}

/** The Requested Documents file with this id in a full snapshot, or null. */
function requestFile_(snap, fileId) {
  var hit = null;
  (snap.sections || []).forEach(function (s) {
    if (s.code !== REQUEST_SECTION) return;
    s.files.forEach(function (f) { if (f.id === fileId) hit = f; });
  });
  return hit;
}

/** After an assignment save: update the cached snapshot (the caller holds the script lock). */
function patchSnapshotRequest_(snap, fileId, names) {
  (snap.sections || []).forEach(function (s) {
    if (s.code === REQUEST_SECTION) s.files.forEach(function (f) { if (f.id === fileId) f.for = names; });
  });
  setSnapshotHashes_(snap);
  cacheSnapshot_(snap);
  PropertiesService.getScriptProperties().deleteProperty('SNAP_HASH');
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

/**
 * Cache `text` in 30 000-character chunks under a new version, plus `<key>:meta` (the fields of
 * `meta` with v, n and at). The previous version's chunks are removed. Returns the meta, or null.
 */
function cachePutChunked_(key, text, meta) {
  var cache = CacheService.getScriptCache();
  var old = cacheMeta_(key);
  var version = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  var n = Math.max(1, Math.ceil(text.length / CACHE_CHUNK));
  var values = {};
  for (var i = 0; i < n; i++) values[key + ':' + version + ':' + i] = text.substr(i * CACHE_CHUNK, CACHE_CHUNK);
  var m = {};
  Object.keys(meta || {}).forEach(function (k) { m[k] = meta[k]; });
  m.v = version;
  m.n = n;
  m.at = Date.now();
  values[key + ':meta'] = JSON.stringify(m);
  try {
    cache.putAll(values, CACHE_TTL);
  } catch (e) {
    console.warn('Cache write failed (the Drive file will be used): ' + e);
    // Drop the old meta too, or readers keep getting the previous version for hours.
    try { cache.remove(key + ':meta'); } catch (e2) { console.warn('Cache meta remove failed: ' + e2); }
    return null;
  }
  // Free the old chunks now instead of leaving them for 6 hours. A reader that still holds the
  // old meta simply falls back to the Drive file.
  if (old && old.v && old.v !== version) {
    try { cache.removeAll(chunkKeys_(key, old)); } catch (e3) { console.warn('Old cache chunks not removed: ' + e3); }
  }
  return m;
}

/** Update fields of a cached meta (e.g. the scan time) without rewriting its chunks. */
function cacheTouchMeta_(key, meta, fields) {
  var m = {};
  Object.keys(meta).forEach(function (k) { m[k] = meta[k]; });
  Object.keys(fields).forEach(function (k) { m[k] = fields[k]; });
  try { CacheService.getScriptCache().put(key + ':meta', JSON.stringify(m), CACHE_TTL); } catch (e) { console.warn('Cache meta update failed: ' + e); }
  return m;
}

/** Was this cached copy written recently enough to keep (chunks live 6 h; rewritten after 5 h)? */
function cacheFresh_(meta) {
  return !!meta && !!meta.at && Date.now() - meta.at < CACHE_REWRITE_MS;
}

function cacheMeta_(key) {
  var raw = CacheService.getScriptCache().get(key + ':meta');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function chunkKeys_(key, meta) {
  var keys = [];
  for (var i = 0; i < meta.n; i++) keys.push(key + ':' + meta.v + ':' + i);
  return keys;
}

/** The text of a cached version, or null if any chunk is gone. */
function cacheGetChunks_(key, meta) {
  if (!meta || !meta.v || !(meta.n > 0)) return null;
  var keys = chunkKeys_(key, meta);
  var got = CacheService.getScriptCache().getAll(keys);
  var parts = [];
  for (var j = 0; j < keys.length; j++) {
    if (got[keys[j]] === undefined || got[keys[j]] === null) return null;
    parts.push(got[keys[j]]);
  }
  return parts.join('');
}

function cacheGetChunked_(key) {
  var meta = cacheMeta_(key);
  var text = meta ? cacheGetChunks_(key, meta) : null;
  return text === null ? null : { text: text, meta: meta };
}
