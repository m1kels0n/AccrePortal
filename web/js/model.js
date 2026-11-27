// Helpers for reading the snapshot tree.
import { CONFIG } from './config.js';
import { href } from './router.js';

export const TYPE_LABELS = {
  S: 'System inputs and processes',
  I: 'Implementation',
  O: 'Outcomes',
};

export function getProgram(code) {
  return CONFIG.programs.find((p) => p.code === code) || null;
}

export function findArea(snap, code) {
  return snap?.areas?.find((a) => a.code === code) || null;
}
export function findParam(area, code) {
  return area?.parameters?.find((p) => p.code === code) || null;
}
export function findIndicator(param, code) {
  return param?.indicators?.find((i) => i.code === code) || null;
}

/** Codes of the made-up rows in links (no Drive folder name parses to them). */
export const GENERAL = '_general';
const SECTION_DOC = '_doc';
const GENERAL_LABEL = 'General documents';
/** Separator the backend puts between nested subfolder names in `file.subfolder`. */
export const SUB_SEP = ' › ';
/** Sections whose top-level subfolders are shown as cards (one card per area folder). */
const GROUPED = { CR: 'Compliance Report', PPP: 'PPP' };
const AREA_NAME_RE = /^area\s*([ivxl]+|\d{1,2})(?![a-z0-9])[\s\-–—:.,_]*(.*)$/i;

/** A made-up area whose files and subfolders sit directly at the top of the tree. */
function docArea(code, name, folderId, files, subfolders, extra) {
  const doc = { code: SECTION_DOC, type: null, text: name, general: true, inline: true, folderId, files, subfolders };
  return { code, name, section: true, folderId, looseFiles: [], ...extra,
    parameters: [{ code: SECTION_DOC, name, general: true, folderId, looseFiles: [], indicators: [doc] }] };
}

/**
 * Compliance Report / PPP: one card per top-level subfolder ("Area 02 - Faculty" → card
 * "Area II · Faculty"), its contents shown as they are in Drive. Files directly in the section
 * folder: a "General documents" card first.
 */
function groupCards(sec, folderId) {
  const cards = new Map();
  const card = (name) => {
    if (!cards.has(name)) cards.set(name, { name, files: [], subfolders: [], folderId: undefined });
    return cards.get(name);
  };
  for (const sf of sec.subfolders || []) {
    const [first, ...rest] = (typeof sf === 'string' ? sf : sf.path).split(SUB_SEP);
    const c = card(first);
    if (!rest.length) { if (sf.id) c.folderId = sf.id; continue; }
    c.subfolders.push(typeof sf === 'string' ? rest.join(SUB_SEP) : { path: rest.join(SUB_SEP), id: sf.id });
  }
  const general = [];
  for (const f of sec.files || []) {
    if (!f.subfolder) { general.push(f); continue; }
    const [first, ...rest] = f.subfolder.split(SUB_SEP);
    card(first).files.push(f);
    if (rest.length) f.subfolder = rest.join(SUB_SEP); else delete f.subfolder;
  }
  const used = new Set();
  const out = [...cards.values()].map((c) => {
    const m = c.name.trim().match(AREA_NAME_RE);
    const num = m ? (/^\d+$/.test(m[1]) ? Number(m[1]) : romanToInt(m[1])) : 0;
    const roman = num > 0 && num <= 50 ? intToRoman(num) : '';
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'folder';
    const base = `${sec.code}-${roman || slug}`;
    let code = base;
    for (let i = 2; used.has(code); i++) code = `${base}-${i}`;
    used.add(code);
    const extra = roman
      ? { label: 'Area ' + roman, badge: roman, sort: [0, num, ''] }
      : { badge: c.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '•', sort: [1, 0, c.name.toLowerCase()] };
    const name = roman ? (m[2].trim() || 'Area ' + roman) : c.name;
    return docArea(code, name, c.folderId, c.files, c.subfolders, { group: sec.code, groupName: GROUPED[sec.code], ...extra });
  }).sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2].localeCompare(b.sort[2], undefined, { numeric: true }));
  if (general.length) {
    out.unshift(docArea(`${sec.code}-GEN`, GENERAL_LABEL, folderId, general, [],
      { group: sec.code, groupName: GROUPED[sec.code], badge: 'GEN' }));
  }
  return out;
}

/**
 * Turn a snapshot into the shape the screens use (safe to run twice):
 * - Actual Self-Survey Report: an area (`section: true`) whose files and subfolders sit directly in the tree.
 * - Compliance Report / PPP: listed in `snap.groups`; each top-level subfolder becomes such an area
 *   with `group: 'CR' | 'PPP'` (shown as cards on the group's page).
 * - Files directly in a Parameter or Area folder (looseFiles): a "General documents" row at the top.
 * - Files directly in the program folder: an "Other documents" area (`general: true`).
 * Made-up rows have `general: true`: not counted in indicator progress, not listed as indicators.
 */
export function prepareSnapshot(snap) {
  if (!snap || !Array.isArray(snap.areas)) return snap;
  const ind = (files, folderId) => ({ code: GENERAL, badge: 'GEN', type: null, text: GENERAL_LABEL, general: true, folderId, files });
  const param = (files, folderId) => ({ code: GENERAL, name: GENERAL_LABEL, general: true, folderId, looseFiles: [], indicators: [ind(files, folderId)] });
  for (const area of snap.areas) {
    for (const p of area.parameters) {
      if (p.looseFiles?.length) p.indicators.unshift(ind(p.looseFiles, p.folderId));
      p.looseFiles = [];
    }
    if (area.looseFiles?.length) area.parameters.unshift(param(area.looseFiles, area.folderId));
    area.looseFiles = [];
  }
  const rootId = (String(snap.program?.rootFolderUrl || '').match(/folders\/([\w-]+)/) || [])[1];
  if (snap.sections?.length || !snap.groups) {
    const made = [];
    snap.groups = [];
    for (const sec of snap.sections || []) {
      const folderId = sec.folderId || rootId;
      if (GROUPED[sec.code]) {
        snap.groups.push({ code: sec.code, name: sec.name, folderId });
        made.push(...groupCards(sec, folderId));
      } else {
        made.unshift(docArea(sec.code, sec.name, folderId, sec.files || [], sec.subfolders || []));
      }
    }
    const order = Object.keys(GROUPED);
    snap.groups.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    snap.areas.unshift(...made);
  }
  snap.sections = [];
  // Reference folders (folder shortcuts at the program root; only the admin's snapshot has them):
  // kept out of snap.areas, so cards, counts, access settings and the top search ignore them.
  if (snap.reference?.length || !snap.referenceAreas) {
    snap.referenceAreas = (snap.reference || []).map((r, i) =>
      docArea(`REF-${i + 1}`, r.name, r.folderId, r.files || [], r.subfolders || [], { reference: true, badge: 'REF' }));
  }
  snap.reference = [];
  if (snap.looseFiles?.length) {
    snap.areas.push({ code: GENERAL, badge: 'GEN', name: 'Other documents', general: true, folderId: rootId, looseFiles: [],
      parameters: [param(snap.looseFiles, rootId)] });
  }
  snap.looseFiles = [];
  return snap;
}

/** Area I … X of the Self-Survey Report and Evidences (no sections, cards or "Other documents"). */
export const realAreas = (snap) => (snap?.areas || []).filter((a) => !a.general && !a.section);
export const findSection = (snap, code) => (snap?.areas || []).find((a) => a.section && !a.group && a.code === code) || null;
export const findGroup = (snap, code) => (snap?.groups || []).find((g) => g.code === code) || null;
export const groupCardsOf = (snap, code) => (snap?.areas || []).filter((a) => a.group === code);
export const otherArea = (snap) => (snap?.areas || []).find((a) => a.general) || null;

/**
 * What the admin can open or hide for accreditors: Compliance Report and PPP as a whole,
 * the Actual Self-Survey Report, and Area I … X. [{ code, label, name, docs }]
 */
export function accessItems(snap) {
  const groups = (snap?.groups || []).map((g) => ({ code: g.code, label: g.name, name: '',
    docs: groupCardsOf(snap, g.code).reduce((n, a) => n + countFiles(a), 0) }));
  const rest = (snap?.areas || []).filter((a) => !a.general && !a.group).map((a) => ({
    code: a.code, label: areaLabel(a), name: a.section ? '' : a.name, docs: countFiles(a) }));
  return [...groups, ...rest];
}

/** The areas listed with this one in the toolbar's area menu (same card page). */
export function siblingAreas(snap, area) {
  if (!area || area.general) return [];
  if (area.group) return groupCardsOf(snap, area.group);
  return (snap?.areas || []).filter((a) => !a.general && !a.group);
}

/** Number of documents under a node. */
export function countFiles(node) {
  if (!node) return 0;
  if (node.files) return node.files.length;
  if (node.indicators) return node.indicators.reduce((n, i) => n + i.files.length, 0);
  if (node.parameters) return node.parameters.reduce((n, p) => n + countFiles(p), 0);
  if (node.areas) return node.areas.reduce((n, a) => n + countFiles(a), 0);
  return 0;
}

/** Indicators with at least one document / total indicators ("General documents" rows left out). */
export function progress(node) {
  let done = 0, total = 0;
  const visit = (ind) => { if (ind.general) return; total++; if (ind.files.length) done++; };
  if (node?.files) visit(node);
  else if (node?.indicators) node.indicators.forEach(visit);
  else if (node?.parameters) node.parameters.forEach((p) => p.indicators.forEach(visit));
  else if (node?.areas) node.areas.forEach((a) => a.parameters.forEach((p) => p.indicators.forEach(visit)));
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/** Group a parameter's indicators by type, keeping S → I → O order. */
export function indicatorsByType(param) {
  const groups = [];
  for (const ind of param.indicators) {
    const key = TYPE_LABELS[ind.type] ? ind.type : 'other';
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, label: TYPE_LABELS[key] || 'Other folders', items: [] }; groups.push(g); }
    g.items.push(ind);
  }
  return groups;
}

/** Call fn(file, ctx) for every indicator file in a snapshot. */
export function eachFile(snap, fn) {
  for (const area of snap?.areas || []) {
    for (const param of area.parameters) {
      for (const ind of param.indicators) {
        for (const file of ind.files) fn(file, { area, param, ind });
      }
    }
  }
}

/** Every document of one area in tree order: [{ param, ind, file }] (for Prev / Next). */
export function areaFileList(area) {
  const out = [];
  for (const param of area?.parameters || []) {
    for (const ind of param.indicators) {
      for (const file of ind.files) out.push({ param, ind, file });
    }
  }
  return out;
}

/** Every place a file id appears (shortcuts can make it appear twice). */
export function locateFile(snap, fileId) {
  const hits = [];
  eachFile(snap, (file, ctx) => { if (file.id === fileId) hits.push({ file, ...ctx }); });
  // Raw mock snapshots (before prepareSnapshot) still keep these in looseFiles.
  for (const f of snap?.looseFiles || []) if (f.id === fileId) hits.push({ file: f });
  for (const sec of snap?.sections || []) for (const f of sec.files || []) if (f.id === fileId) hits.push({ file: f });
  for (const area of snap?.areas || []) {
    for (const f of area.looseFiles || []) if (f.id === fileId) hits.push({ file: f, area });
    for (const param of area.parameters) {
      for (const f of param.looseFiles || []) if (f.id === fileId) hits.push({ file: f, area, param });
    }
  }
  // Reference folders (admin only): prepared ones, and raw mock snapshots that still have `reference`.
  for (const area of snap?.referenceAreas || []) {
    for (const param of area.parameters) {
      for (const ind of param.indicators) for (const f of ind.files) if (f.id === fileId) hits.push({ file: f, area, param, ind, reference: true });
    }
  }
  for (const r of snap?.reference || []) for (const f of r.files || []) if (f.id === fileId) hits.push({ file: f, reference: true });
  return hits;
}

export function areaLabel(area) { return area.label || (area.general || area.section ? area.name : isRoman(area.code) ? 'Area ' + area.code : area.code); }
/** "Area I — Vision, Mission …", "Compliance Report › Area II — Faculty", or just "PPP". */
export function areaTitle(area) {
  const l = areaLabel(area);
  const base = l === area.name ? l : l + ' — ' + area.name;
  return area.groupName ? area.groupName + ' › ' + base : base;
}
export function paramLabel(param) { return param.general ? param.name : /^[A-Z]$/.test(param.code) ? 'Parameter ' + param.code : param.code; }
export function indLabel(ind) { return ind.general ? ind.text : ind.code; }
/** Short code for badges ("GEN" for General rows, "CR" / "PPP" / "SSR", "II" for an area card). */
export function shortCode(node) { return node.badge || node.code; }
/** "Parameter A › S.1", "Parameter A › General documents", or just "General documents". */
export function placeLabel(param, ind) { return param.general ? indLabel(ind) : paramLabel(param) + ' › ' + indLabel(ind); }
function isRoman(code) { return /^[IVXL]+$/.test(code); }

/** Comparison key for an area code; must match normalizeAreaCode_ in Code.gs ("Area 2", "ii", "II" → "II"). */
export function areaKey(v) {
  const s = String(v ?? '').trim().replace(/^area\s*/i, '');
  if (/^\d+$/.test(s)) return intToRoman(Number(s));
  if (/^[IVXL]+$/i.test(s)) return s.toUpperCase();
  return s.toLowerCase();
}
// Same as romanToInt_ in Structure.gs.
function romanToInt(r) {
  const v = { I: 1, V: 5, X: 10, L: 50 };
  const t = String(r).toUpperCase();
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = v[t[i]], next = v[t[i + 1]] || 0;
    if (!cur) return 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}
// Same as intToRoman_ in Structure.gs.
function intToRoman(n) {
  let out = '';
  for (const [v, r] of [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
    while (n >= v) { out += r; n -= v; }
  }
  return out;
}

export function hrefFor(prog, area, param, ind, fileId, q) {
  const parts = [prog, area?.code, param?.code, ind?.code];
  if (fileId) parts.push('f', fileId);
  return href(parts, q);
}

export function docCountLabel(n) {
  return n === 0 ? 'No documents yet' : n === 1 ? '1 document' : n + ' documents';
}

/** A document opened from the All files page: #/files/<prog>/<area>/<param>/<ind>/<fileId>. */
export function filesHref(prog, area, param, ind, fileId) {
  return href(['files', prog, area.code, param.code, ind.code, fileId]);
}

/**
 * The Drive folder a file sits in: its subfolder when it is in one (staff snapshots carry the
 * subfolder ids), otherwise the indicator's folder. Null for accreditors (no folder ids).
 */
export function fileFolderId(ind, file) {
  if (file.subfolder) {
    const sf = (ind.subfolders || []).find((s) => s && typeof s === 'object' && s.path === file.subfolder);
    if (sf?.id) return sf.id;
  }
  return ind.folderId || null;
}
