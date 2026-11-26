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

/** Code of the "General documents" rows in links (no Drive folder name parses to it). */
export const GENERAL = '_general';
const GENERAL_LABEL = 'General documents';

/**
 * Files sitting directly in a Parameter folder, an Area folder or the program root (looseFiles)
 * become a "General documents" indicator at the top of that parameter, a "General documents"
 * row at the top of that area, and a "General" area first in the list. Shown to everyone like
 * any other document; not counted in indicator progress. Safe to run twice (empties looseFiles).
 */
export function withGeneral(snap) {
  if (!snap || !Array.isArray(snap.areas)) return snap;
  const ind = (files, folderId) => ({ code: GENERAL, type: null, text: GENERAL_LABEL, general: true, folderId, files });
  const param = (files, folderId) => ({ code: GENERAL, name: GENERAL_LABEL, general: true, folderId, looseFiles: [], indicators: [ind(files, folderId)] });
  for (const area of snap.areas) {
    for (const p of area.parameters) {
      if (p.looseFiles?.length) p.indicators.unshift(ind(p.looseFiles, p.folderId));
      p.looseFiles = [];
    }
    if (area.looseFiles?.length) area.parameters.unshift(param(area.looseFiles, area.folderId));
    area.looseFiles = [];
  }
  if (snap.looseFiles?.length) {
    const rootId = (String(snap.program?.rootFolderUrl || '').match(/folders\/([\w-]+)/) || [])[1];
    snap.areas.unshift({ code: GENERAL, name: 'Program-wide documents', general: true, folderId: rootId, looseFiles: [], parameters: [param(snap.looseFiles, rootId)] });
  }
  snap.looseFiles = [];
  return snap;
}

/** The real accreditation areas (without the "General" one). */
export const realAreas = (snap) => (snap?.areas || []).filter((a) => !a.general);

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
  // Raw mock snapshots (before withGeneral) still keep these in looseFiles.
  for (const f of snap?.looseFiles || []) if (f.id === fileId) hits.push({ file: f });
  for (const area of snap?.areas || []) {
    for (const f of area.looseFiles || []) if (f.id === fileId) hits.push({ file: f, area });
    for (const param of area.parameters) {
      for (const f of param.looseFiles || []) if (f.id === fileId) hits.push({ file: f, area, param });
    }
  }
  return hits;
}

export function areaLabel(area) { return area.general ? 'General' : isRoman(area.code) ? 'Area ' + area.code : area.code; }
export function paramLabel(param) { return param.general ? GENERAL_LABEL : /^[A-Z]$/.test(param.code) ? 'Parameter ' + param.code : param.code; }
export function indLabel(ind) { return ind.general ? GENERAL_LABEL : ind.code; }
/** Short code for badges ("GEN" for the General rows). */
export function shortCode(node) { return node.general ? 'GEN' : node.code; }
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
