/**
 * AACCUP Accreditation Evidence Portal: Apps Script backend.
 * Code.gs: menu, setup, config, logging, triggers.
 *
 * One Google Sheet per program, each with this same script bound to it.
 * Files: Code.gs, Security.gs, Structure.gs, Snapshot.gs, Api.gs, appsscript.json
 */

var SHEET_HEADERS = {
  Config: ['key', 'value'],
  Structure: ['level', 'code', 'name', 'text', 'folderId', 'parentFolderId', 'areaCode', 'parameterCode',
              'sortKey', 'path', 'status', 'rawName', 'codeOverride', 'nameOverride', 'textOverride', 'hidden'],
  Keywords: ['fileId', 'keywords', 'updatedBy', 'updatedAt'],
  Access: ['accreditorName', 'pinHash'],
  Log: ['timestamp', 'action', 'user', 'details'],
};
var CONFIG_KEYS = ['programCode', 'programName', 'rootFolderId', 'driveId', 'systemFolderId',
                   'snapshotFileId', 'issuesFileId', 'timezone', 'authMode',
                   'adminPinHash', 'coordinatorPinHash',
                   'accreditorEnabled', 'accreditorAreas', 'watermark'];
// Starting values for new Config rows. The admin panel on the website changes the last three.
var CONFIG_DEFAULTS = { accreditorEnabled: 'TRUE', accreditorAreas: 'ALL', watermark: 'TRUE' };
var FOLDER_MIME = 'application/vnd.google-apps.folder';
var SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
var LOG_MAX_ROWS = 3000;

// ── Menu ─────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('AACCUP')
    .addItem('1. Setup / check settings', 'setup')
    .addItem('2. Build structure (read folders)', 'menuBuildStructure')
    .addItem('3. Build snapshot now', 'menuBuildSnapshot')
    .addSeparator()
    .addItem('Set admin PIN', 'setAdminPin')
    .addItem('Set coordinator PIN (shared)', 'setCoordinatorPin')
    .addItem('Set one accreditor PIN', 'setAccreditorPin')
    .addItem('Generate accreditor PINs (Access list)', 'generatePins')
    .addSeparator()
    .addItem('Show link key (main Sheet)', 'showLinkKey')
    .addItem('Link to main program (other Sheets)', 'linkToMain')
    .addSeparator()
    .addItem('Install 5-minute auto-refresh', 'installTrigger')
    .addItem('Remove auto-refresh', 'removeTrigger')
    .addItem('Status & deploy checklist', 'showStatus')
    .addToUi();
}

// ── Setup ────────────────────────────────────────────────────
function setup() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ensureSheets_();
  getSalt_();
  var cfg = getConfig_();

  if (!cfg.timezone) setConfig_('timezone', Session.getScriptTimeZone() || 'Asia/Manila');
  if (!cfg.programCode) {
    var code = promptText_('Program code', 'Short code used in website links, e.g. p1 or p2.', 'p1');
    if (code === null) return;
    setConfig_('programCode', code.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'p1');
  }
  if (!cfg.programName) {
    var name = promptText_('Program name', 'Full program name shown on the website.', 'Program 1');
    if (name === null) return;
    setConfig_('programName', name);
  }
  if (!cfg.rootFolderId || !folderExists_(cfg.rootFolderId)) {
    var link = promptText_('Root folder', 'Paste the link (or ID) of this program\'s root Drive folder (the one that contains the Area folders).', '');
    if (link === null) return;
    var id = extractId_(link);
    if (!id || !folderExists_(id)) {
      ui.alert('Folder not found', 'I could not open that folder. Check the link and that you have access, then run Setup again.', ui.ButtonSet.OK);
      return;
    }
    setConfig_('rootFolderId', id);
  }
  cfg = getConfig_();
  if (!cfg.authMode) {
    var main = ui.alert('Main program?',
      'Is this the MAIN program Sheet?\n\n' +
      'YES = this Sheet holds all PINs and handles logins for every program (normally Program 1).\n' +
      'NO = this Sheet is linked to the main one (e.g. Program 2). You will paste the link key from the main Sheet.',
      ui.ButtonSet.YES_NO);
    if (main === ui.Button.YES) {
      setConfig_('authMode', 'main');
    } else if (main === ui.Button.NO) {
      linkToMain();
      if (!PropertiesService.getScriptProperties().getProperty('TOKEN_KEY')) return;
    } else {
      return;
    }
  }
  cfg = getConfig_();
  if (isMain_()) getTokenKey_(); // creates the link key once
  ensureSystemFiles_(cfg);
  cfg = getConfig_();

  var missing = [];
  if (isMain_()) {
    if (!cfg.adminPinHash) missing.push('• AACCUP → Set admin PIN');
    if (!cfg.coordinatorPinHash) missing.push('• AACCUP → Set coordinator PIN (shared)');
    if (!readAccess_().some(function (r) { return r.pinHash; })) missing.push('• Fill the Access tab (one accreditor name per row), then AACCUP → Generate PINs');
  } else if (!PropertiesService.getScriptProperties().getProperty('TOKEN_KEY')) {
    missing.push('• AACCUP → Link to main program (paste the link key)');
  }
  ui.alert('Setup complete',
    'Program: ' + cfg.programName + ' (' + cfg.programCode + ')' + (isMain_() ? ' · MAIN Sheet' : ' · linked Sheet') + '\n' +
    'Root folder: ' + DriveApp.getFolderById(cfg.rootFolderId).getName() + '\n\n' +
    'Next steps:\n' +
    '• AACCUP → 2. Build structure, then review the Structure tab\n' +
    '• AACCUP → 3. Build snapshot now\n' +
    (missing.length ? missing.join('\n') + '\n' : '') +
    '• AACCUP → Install 5-minute auto-refresh\n' +
    '• Deploy → New deployment → Web app (see README)',
    ui.ButtonSet.OK);
}

function ensureSheets_() {
  var ss = ss_();
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    if (name === 'Access') {
      // Older versions listed COORDINATORS in Access. Now it lists accreditors, so keep the old
      // tab under another name (nothing is deleted) and start a fresh one.
      var old = ss.getSheetByName('Access');
      var a1 = old ? String(old.getRange(1, 1).getValue()).trim() : '';
      if (a1 === 'area' || a1 === 'coordinatorName') {
        var keep = 'Access (old coordinators)';
        old.setName(ss.getSheetByName(keep) ? keep + ' ' + Date.now() : keep);
      }
    }
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SHEET_HEADERS[name];
    var current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (current.join('|') !== headers.join('|')) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    if (name === 'Config') {
      var keys = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
      CONFIG_KEYS.forEach(function (k) { if (keys.indexOf(k) === -1) sh.appendRow([k, CONFIG_DEFAULTS[k] || '']); });
    }
    if (name === 'Structure') {
      sh.getRange(1, 13, 1, 4).setBackground('#fff2cc').setNote('You may edit these 4 columns. They are kept when the structure is rebuilt.');
      if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
        sh.protect().setDescription('Auto-generated: edit only the override columns').setWarningOnly(true);
      }
    }
  });
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
}

function ensureSystemFiles_(cfg) {
  var folder = null;
  if (cfg.systemFolderId) {
    try { folder = DriveApp.getFolderById(cfg.systemFolderId); if (folder.isTrashed()) folder = null; } catch (e) { folder = null; }
  }
  if (!folder) {
    // Created in your own My Drive (NOT inside the public program folder), so it stays private.
    folder = DriveApp.createFolder('_system AACCUP ' + cfg.programCode + ' (do not share)');
    setConfig_('systemFolderId', folder.getId());
  }
  ['snapshotFileId:snapshot.json', 'issuesFileId:issues.json'].forEach(function (pair) {
    var key = pair.split(':')[0], fname = pair.split(':')[1];
    var ok = false;
    if (cfg[key]) { try { ok = !DriveApp.getFileById(cfg[key]).isTrashed(); } catch (e) { ok = false; } }
    if (!ok) setConfig_(key, folder.createFile(fname, '{}', 'application/json').getId());
  });
}

// ── Menu wrappers ────────────────────────────────────────────
function menuBuildStructure() {
  var ui = SpreadsheetApp.getUi();
  var res = buildStructure();
  if (!res.ok) { ui.alert('Build structure', res.message || res.error, ui.ButtonSet.OK); return; }
  ui.alert('Structure built',
    res.counts.area + ' areas, ' + res.counts.parameter + ' parameters, ' + res.counts.indicator + ' indicators' +
    (res.counts.group ? ' (' + res.counts.group + ' S/I/O group folders)' : '') + '.\n' +
    res.issueCount + ' naming issue(s): see rows with status "badName"/"duplicateCode" in the Structure tab.\n\n' +
    'Fix a bad name in Drive, or type a codeOverride / nameOverride / textOverride, or set hidden = TRUE for junk folders, then build again.\n\n' +
    'Next: AACCUP → 3. Build snapshot now.', ui.ButtonSet.OK);
}

function menuBuildSnapshot() {
  var ui = SpreadsheetApp.getUi();
  var res = runSnapshot_('menu');
  if (!res.ok) { ui.alert('Build snapshot', res.message || res.error, ui.ButtonSet.OK); return; }
  ui.alert('Snapshot built',
    res.stats.files + ' documents in ' + res.stats.indicatorsWithFiles + ' of ' + res.stats.indicators + ' indicators.\n' +
    res.issueCount + ' issue(s) found (see the admin panel on the website).\n' +
    'Took ' + (res.ms / 1000).toFixed(1) + ' s.', ui.ButtonSet.OK);
}

// ── Triggers ─────────────────────────────────────────────────
function installTrigger() {
  removeTrigger_(true);
  ScriptApp.newTrigger('buildSnapshot').timeBased().everyMinutes(5).create();
  SpreadsheetApp.getUi().alert('Auto-refresh is ON: the file list is rescanned every 5 minutes.');
}
function removeTrigger() { removeTrigger_(false); }
function removeTrigger_(silent) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'buildSnapshot') ScriptApp.deleteTrigger(t);
  });
  if (!silent) SpreadsheetApp.getUi().alert('Auto-refresh is OFF.');
}
function triggerActive_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'buildSnapshot'; });
}

function showStatus() {
  var cfg = getConfig_();
  var p = PropertiesService.getScriptProperties();
  var st = readSettings_();
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  SpreadsheetApp.getUi().alert('Status',
    'Program: ' + (cfg.programName || '?') + ' (' + (cfg.programCode || '?') + ')\n' +
    'Root folder ID: ' + (cfg.rootFolderId || 'NOT SET') + '\n' +
    'Sheet role: ' + (isMain_() ? 'MAIN (holds the PINs, handles logins)' : 'linked to the main program') + '\n' +
    'Link key: ' + (p.getProperty('TOKEN_KEY') ? 'set' : 'NOT SET') + '\n' +
    (isMain_()
      ? 'Admin PIN set: ' + (cfg.adminPinHash ? 'yes' : 'NO') + '\n' +
        'Coordinator PIN (shared) set: ' + (cfg.coordinatorPinHash ? 'yes' : 'NO') + '\n' +
        'Accreditors with PIN: ' + readAccess_().filter(function (r) { return r.pinHash; }).length + '\n'
      : '') +
    'Accreditors: ' + (st.accreditorEnabled ? 'open' : 'CLOSED') + ' · areas: ' +
      [].concat(st.accreditorAreas).join(', ') + ' · watermark ' + (st.watermark ? 'on' : 'off') + '\n' +
    'Auto-refresh trigger: ' + (triggerActive_() ? 'ON' : 'OFF') + '\n' +
    'Last scan: ' + (p.getProperty('LAST_SCAN') || 'never') + ' (' + (p.getProperty('LAST_SCAN_MS') || '?') + ' ms)\n' +
    'Web app URL: ' + (url || 'not deployed yet') + '\n\n' +
    'Deploy checklist:\n' +
    '1. Deploy → New deployment → type: Web app\n' +
    '2. Execute as: Me · Who has access: Anyone\n' +
    '3. Copy the URL ending in /exec into web/js/config.js (apiUrl)\n' +
    '4. After code changes: Deploy → Manage deployments → Edit → Version: New version',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

// ── Config / sheets helpers ──────────────────────────────────
var CONFIG_MEMO_ = null;

function ss_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Spreadsheet not known yet: open the Sheet and run AACCUP → Setup once.');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run AACCUP → Setup.');
  return sh;
}

function getConfig_() {
  if (CONFIG_MEMO_) return CONFIG_MEMO_;
  var sh = sheet_('Config');
  var cfg = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0]) cfg[String(r[0]).trim()] = String(r[1] === null ? '' : r[1]).trim();
    });
  }
  CONFIG_MEMO_ = cfg;
  return cfg;
}

function setConfig_(key, value) {
  var sh = sheet_('Config');
  var n = Math.max(sh.getLastRow() - 1, 0);
  var keys = n ? sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
  var i = keys.indexOf(key);
  if (i === -1) sh.appendRow([key, value]);
  else sh.getRange(i + 2, 2).setValue(value);
  CONFIG_MEMO_ = null;
}

function requireConfig_(keys) {
  var cfg = getConfig_();
  var missing = keys.filter(function (k) { return !cfg[k]; });
  if (missing.length) throw new Error('Missing settings: ' + missing.join(', ') + '. Run AACCUP → Setup.');
  return cfg;
}

/** Read a tab as an array of objects keyed by the header row. */
function readTable_(name) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  var lastCol = SHEET_HEADERS[name].length;
  if (lastRow < 2) return [];
  var headers = SHEET_HEADERS[name];
  return sh.getRange(2, 1, lastRow - 1, lastCol).getValues().map(function (r, i) {
    var o = { _row: i + 2 };
    headers.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

/** Accreditors: one row each (name + PIN hash). What they can see is set in the admin panel. */
function readAccess_() {
  return readTable_('Access').map(function (r) {
    return {
      _row: r._row,
      accreditorName: String(r.accreditorName || '').trim(),
      pinHash: String(r.pinHash || '').trim(),
    };
  }).filter(function (r) { return r.accreditorName || r.pinHash; });
}

function normalizeAreaCode_(v) {
  var s = String(v || '').trim().toUpperCase().replace(/^AREA\s*/, '');
  if (/^\d+$/.test(s)) s = intToRoman_(Number(s));
  return s;
}

function log_(action, user, details) {
  try {
    var sh = sheet_('Log');
    sh.appendRow([new Date(), action, user || '', typeof details === 'string' ? details : JSON.stringify(details || '')]);
    if (sh.getLastRow() > LOG_MAX_ROWS) sh.deleteRows(2, 1000);
  } catch (e) {
    console.error('log_ failed: ' + e);
  }
}

// ── Small utilities ──────────────────────────────────────────
function promptText_(title, message, def) {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt(title, message + (def ? '\n(Leave blank for "' + def + '")' : ''), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  return r.getResponseText().trim() || def || '';
}

function extractId_(s) {
  var m = String(s || '').match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

function folderExists_(id) {
  try { return !DriveApp.getFolderById(id).isTrashed(); } catch (e) { return false; }
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function md5_(text) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8));
}

function toSet_(arr) {
  var s = {};
  arr.forEach(function (x) { s[x] = true; });
  return s;
}
