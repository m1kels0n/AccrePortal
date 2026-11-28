/**
 * Structure.gs: reads the folder tree ONCE and saves it (by folder ID) in the Structure tab.
 *
 * Expected tree:  Root › Area I … X › Parameter A, B … › S.1, S.2, I.1, O.1 …
 * Also accepted:  Parameter › "System Inputs and Processes" / "Implementation" / "Outcomes"
 *                 (or "S" / "I" / "O") › S.1 …   ← transparent "group" folders
 * Sections:       Root › "Compliance Report" / "PPP" / "Actual Self-Survey Report" / "Requested Documents"
 *                 (any folder name with "request"): any folders inside,
 *                 scanned like an indicator's subfolders (the site shows each top-level subfolder of
 *                 Compliance Report and PPP as a card). A FILE at the root with one of these names
 *                 joins that section too (see sectionOf_).
 *
 * Folder names are parsed tolerantly (-, –, —, :, extra spaces, any case).
 * Override columns (codeOverride, nameOverride, textOverride, hidden) are kept across rebuilds.
 */

var SEP_RE = '[\\s\\-–—:.,_]*';
var AREA_RE = new RegExp('^area' + '\\s*([ivxl]+|\\d{1,2})(?![a-z0-9])' + SEP_RE + '(.*)$', 'i');
var PARAM_RE = new RegExp('^param(?:eter)?\\.?\\s*([a-z])(?![a-z0-9])' + SEP_RE + '(.*)$', 'i');
var IND_RE = new RegExp('^([sio])\\s*[.\\-–—]?\\s*(\\d+(?:\\.\\d+)*)(?![\\d])' + SEP_RE + '(.*)$', 'i');
var GROUP_RE = /^(?:[sio]\s*[-–—:.]\s*)?(system|inputs?|implementation|outcomes?)\b/i;
var TYPE_ORDER = { S: 1, I: 2, O: 3 };
var SECTIONS = {
  CR: { name: 'Compliance Report', order: 1 },
  PPP: { name: 'Program Performance Profile', order: 2 },
  SSR: { name: 'Actual Self-Survey Report', order: 3 },
  // Documents accreditors asked the coordinators for. Each file is shown only to the
  // accreditor(s) a coordinator ticked for it (Requests tab); see snapshotFor_ in Api.gs.
  REQ: { name: 'Requested Documents', order: 4 },
};
var REQUEST_SECTION = 'REQ';

/**
 * Section code for a root folder or file name ("Compliance Report.pdf" → CR), or ''.
 * Requested Documents is a folder only (isFolder true): a root FILE with "request" in its
 * name stays in "Other documents", so it never becomes hidden from accreditors by accident.
 */
function sectionOf_(raw, isFolder) {
  var name = cleanName_(raw).replace(/\.[a-z0-9]{2,5}$/i, '');
  if (AREA_RE.test(name)) return '';
  if (isFolder && /request/i.test(name)) return REQUEST_SECTION;
  if (/compliance/i.test(name)) return 'CR';
  if (/\bppp\b|performance[\s\-–—_]*profile/i.test(name)) return 'PPP';
  if (/self[\s\-–—_]*survey/i.test(name)) return 'SSR';
  return '';
}

/** Public: run from the menu or the admin panel. */
function buildStructure() {
  if (!acquireScan_()) return { ok: false, error: 'busy', message: 'A scan is running. Try again in a minute.' };
  try {
    return buildStructure_();
  } catch (err) {
    log_('structureError', '', String(err && err.message || err));
    return { ok: false, error: 'server', message: String(err && err.message || err) };
  } finally {
    releaseScan_();
  }
}

function buildStructure_() {
  var cfg = requireConfig_(['rootFolderId']);
  var t0 = Date.now();
  var overrides = {};
  readTable_('Structure').forEach(function (r) { if (r.folderId) overrides[r.folderId] = r; });

  var rows = [];
  var counts = { section: 0, area: 0, parameter: 0, group: 0, indicator: 0 };
  var usable = function (f) { return f.name.charAt(0) !== '_' && f.id !== cfg.systemFolderId; };

  // Level 1: sections (Compliance Report, PPP, Self-Survey Instrument) and areas
  var areaRows = [];
  var sectionRows = [];
  listChildren_([cfg.rootFolderId], true, 'description').filter(usable).forEach(function (f) {
    if (sectionOf_(f.name, true)) sectionRows.push(makeRow_('section', f, null, overrides));
    else areaRows.push(makeRow_('area', f, null, overrides));
  });
  dedupeCodes_(sectionRows);
  dedupeCodes_(areaRows);
  rows = rows.concat(sectionRows, areaRows);

  // Level 2: parameters
  var openAreas = areaRows.filter(function (r) { return !r.hiddenFlag; });
  var areaById = byId_(openAreas);
  var paramRows = listChildren_(ids_(openAreas), true, 'description').filter(usable).map(function (f) {
    return makeRow_('parameter', f, areaById[f.parents[0]], overrides);
  });
  dedupeCodes_(paramRows);
  rows = rows.concat(paramRows);

  // Level 3: indicators (or S/I/O group folders)
  var openParams = paramRows.filter(function (r) { return !r.hiddenFlag; });
  var paramById = byId_(openParams);
  var level3 = listChildren_(ids_(openParams), true, 'description').filter(usable);
  var indRows = [];
  var groupRows = [];
  level3.forEach(function (f) {
    var parent = paramById[f.parents[0]];
    var name = cleanName_(f.name);
    var isGroup = /^[sio]$/i.test(name) || (!IND_RE.test(name) && GROUP_RE.test(name));
    if (isGroup) groupRows.push(makeRow_('group', f, parent, overrides));
    else indRows.push(makeRow_('indicator', f, parent, overrides));
  });

  // Level 4: indicators inside group folders
  var openGroups = groupRows.filter(function (r) { return !r.hiddenFlag; });
  if (openGroups.length) {
    var groupById = byId_(openGroups);
    listChildren_(ids_(openGroups), true, 'description').filter(usable).forEach(function (f) {
      indRows.push(makeRow_('indicator', f, groupById[f.parents[0]], overrides));
    });
  }
  dedupeCodes_(indRows, function (r) { return r.areaCode + '|' + r.parameterCode; });
  rows = rows.concat(groupRows, indRows);

  rows.forEach(function (r) { counts[r.level]++; });
  var issueCount = rows.filter(function (r) { return r.status !== 'ok'; }).length;
  rows = rows.concat(hiddenLeftovers_(rows, overrides));
  rows.sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0; });
  writeStructure_(rows);

  log_('buildStructure', '', counts.area + ' areas, ' + counts.parameter + ' parameters, ' + counts.indicator +
       ' indicators, ' + issueCount + ' naming issues, ' + (Date.now() - t0) + ' ms');
  return { ok: true, counts: counts, issueCount: issueCount, ms: Date.now() - t0 };
}

/**
 * Folders under a hidden folder are not listed, so their old rows (and override columns)
 * would be lost. Keep those old rows as they were, so un-hiding later restores them.
 */
function hiddenLeftovers_(rows, old) {
  var fresh = byId_(rows);
  var out = [];
  Object.keys(old).forEach(function (id) {
    if (fresh[id]) return;
    for (var x = old[id], guard = 0; x && guard < 10; x = old[x.parentFolderId], guard++) {
      var parent = fresh[x.parentFolderId];
      if (parent) {
        if (parent.hiddenFlag) {
          var keep = { hiddenFlag: true };
          SHEET_HEADERS.Structure.forEach(function (h) { keep[h] = old[id][h]; });
          out.push(keep);
        }
        return;
      }
    }
  });
  return out;
}

/** Build one Structure row from a Drive folder. */
function makeRow_(level, f, parent, overrides) {
  var o = overrides[f.id] || {};
  var parsed = parseFolderName_(level, f.name);
  var codeOv = String(o.codeOverride || '').trim();
  if (codeOv) {
    var re = parseFolderName_(level, level === 'area' ? 'Area ' + codeOv : level === 'parameter' ? 'Parameter ' + codeOv : codeOv);
    parsed = re.ok ? { ok: true, code: re.code, rest: parsed.rest, sort: re.sort }
                   : { ok: true, code: codeOv, rest: parsed.rest, sort: 'y-' + codeOv.toLowerCase() };
  }
  var hidden = isTrue_(o.hidden);
  var row = {
    level: level,
    code: parsed.code,
    name: String(o.nameOverride || '').trim() || parsed.rest || cleanName_(f.name),
    text: '',
    folderId: f.id,
    parentFolderId: parent ? parent.folderId : (f.parents ? f.parents[0] : ''),
    areaCode: level === 'area' ? parsed.code : parent ? parent.areaCode : '',
    parameterCode: level === 'parameter' ? parsed.code : parent ? parent.parameterCode : '',
    sortKey: (parent ? parent.sortKey + '/' : '') + parsed.sort,
    path: '',
    status: parsed.ok ? 'ok' : 'badName',
    rawName: f.name,
    codeOverride: o.codeOverride || '',
    nameOverride: o.nameOverride || '',
    textOverride: o.textOverride || '',
    hidden: o.hidden || '',
    hiddenFlag: hidden || (parent ? parent.hiddenFlag : false),
  };
  if (level === 'indicator') {
    row.text = String(o.textOverride || '').trim() || String(f.description || '').trim() || parsed.rest || row.code;
    row.name = row.text;
    // Indicators inside an S/I/O group sort by their own code under the parameter.
    if (parent && parent.level === 'group') row.sortKey = parent.sortKey.replace(/\/[^/]*$/, '') + '/' + parsed.sort;
  }
  if (level === 'area' && f.description && !o.nameOverride && !parsed.rest) row.name = String(f.description).trim();
  row.path = (parent ? parent.path + ' > ' : '') + labelFor_(level, row);
  return row;
}

function labelFor_(level, row) {
  if (level === 'area') return /^[IVXL]+$/.test(row.code) ? 'Area ' + row.code : row.rawName;
  if (level === 'parameter') return /^[A-Z]$/.test(row.code) ? 'Parameter ' + row.code : row.rawName;
  if (level === 'group') return row.rawName;
  if (level === 'section') return row.name;
  return row.code;
}

/**
 * Parse a folder name. Returns { ok, code, rest, sort }.
 * Unrecognised names get ok:false, a slug code, and sort last.
 */
function parseFolderName_(level, raw) {
  var name = cleanName_(raw);
  var m;
  if (level === 'area') {
    m = name.match(AREA_RE);
    if (m) {
      var num = /^\d+$/.test(m[1]) ? Number(m[1]) : romanToInt_(m[1]);
      if (num > 0 && num <= 50) return { ok: true, code: intToRoman_(num), rest: m[2].trim(), sort: pad_(num, 3) };
    }
  } else if (level === 'parameter') {
    m = name.match(PARAM_RE);
    if (m) return { ok: true, code: m[1].toUpperCase(), rest: m[2].trim(), sort: m[1].toUpperCase() };
  } else if (level === 'section') {
    var sc = sectionOf_(name, true);
    if (SECTIONS[sc]) return { ok: true, code: sc, rest: SECTIONS[sc].name, sort: '0-' + SECTIONS[sc].order };
  } else if (level === 'group') {
    var t = (name.match(/^[sio]\b/i) || name.match(GROUP_RE) || [''])[0].charAt(0).toUpperCase();
    return { ok: true, code: TYPE_ORDER[t] ? t : slug_(name), rest: name, sort: '0-' + (TYPE_ORDER[t] || 9) };
  } else if (level === 'indicator') {
    m = name.match(IND_RE);
    if (m) {
      var type = m[1].toUpperCase();
      var nums = m[2].split('.');
      return {
        ok: true,
        code: type + '.' + nums.join('.'),
        rest: m[3].trim(),
        sort: TYPE_ORDER[type] + '-' + nums.map(function (n) { return pad_(Number(n), 3); }).join('.'),
      };
    }
  }
  return { ok: false, code: slug_(name), rest: name, sort: 'z-' + name.toLowerCase() };
}

function dedupeCodes_(rows, keyFn) {
  var seen = {};
  rows.forEach(function (r) {
    var key = (keyFn ? keyFn(r) : r.parentFolderId) + '|' + r.code;
    if (seen[key]) {
      seen[key]++;
      r.code = r.code + '-' + seen[key];
      r.status = 'duplicateCode';
      r.sortKey += '-' + seen[key];
    } else {
      seen[key] = 1;
    }
  });
}

function writeStructure_(rows) {
  var sh = sheet_('Structure');
  var headers = SHEET_HEADERS.Structure;
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).clearContent();
  if (!rows.length) return;
  var values = rows.map(function (r) { return headers.map(function (h) { return r[h] === undefined ? '' : r[h]; }); });
  sh.getRange(2, 1, values.length, headers.length).setNumberFormat('@').setValues(values);
}

/**
 * Read the saved structure for the scanner.
 * Hidden folders (and everything under them) are left out of `rows`.
 */
function readStructure_() {
  var all = readTable_('Structure').filter(function (r) { return r.folderId; }).map(function (r) {
    return {
      level: String(r.level), code: String(r.code), name: String(r.name), text: String(r.text),
      folderId: String(r.folderId), parentFolderId: String(r.parentFolderId),
      areaCode: String(r.areaCode), parameterCode: String(r.parameterCode),
      sortKey: String(r.sortKey), path: String(r.path), status: String(r.status), rawName: String(r.rawName),
      hidden: isTrue_(r.hidden),
    };
  });
  var allById = byId_(all);
  var isHidden = function (r) {
    for (var x = r, guard = 0; x && guard < 10; x = allById[x.parentFolderId], guard++) if (x.hidden) return true;
    return false;
  };
  var rows = all.filter(function (r) { return !isHidden(r); });
  var byId = byId_(rows);
  rows.forEach(function (r) {
    if (r.level === 'indicator') {
      var p = byId[r.parentFolderId];
      r.paramFolderId = p && p.level === 'group' ? p.parentFolderId : r.parentFolderId;
    }
  });
  return { rows: rows, byId: byId, allById: allById };
}

// ── helpers ──────────────────────────────────────────────────
function cleanName_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function pad_(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
function slug_(s) { return cleanName_(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'folder'; }
function isTrue_(v) { return v === true || /^(true|yes|y|1|x)$/i.test(String(v || '').trim()); }
function ids_(rows) { return rows.map(function (r) { return r.folderId; }); }
function byId_(rows) { var m = {}; rows.forEach(function (r) { m[r.folderId] = r; }); return m; }

function romanToInt_(s) {
  var v = { I: 1, V: 5, X: 10, L: 50 };
  s = String(s).toUpperCase();
  var total = 0;
  for (var i = 0; i < s.length; i++) {
    var cur = v[s[i]], next = v[s[i + 1]] || 0;
    if (!cur) return 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

function intToRoman_(n) {
  var map = [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  var out = '';
  map.forEach(function (p) { while (n >= p[0]) { out += p[1]; n -= p[0]; } });
  return out;
}
