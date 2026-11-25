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

/** Number of documents under a node (misplaced files are not counted). */
export function countFiles(node) {
  if (!node) return 0;
  if (node.files) return node.files.length;
  if (node.indicators) return node.indicators.reduce((n, i) => n + i.files.length, 0);
  if (node.parameters) return node.parameters.reduce((n, p) => n + countFiles(p), 0);
  if (node.areas) return node.areas.reduce((n, a) => n + countFiles(a), 0);
  return 0;
}

/** Indicators with at least one document / total indicators. */
export function progress(node) {
  let done = 0, total = 0;
  const visit = (ind) => { total++; if (ind.files.length) done++; };
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
  for (const area of snap?.areas || []) {
    for (const f of area.looseFiles || []) if (f.id === fileId) hits.push({ file: f, area });
    for (const param of area.parameters) {
      for (const f of param.looseFiles || []) if (f.id === fileId) hits.push({ file: f, area, param });
    }
  }
  return hits;
}

export function areaLabel(area) { return isRoman(area.code) ? 'Area ' + area.code : area.code; }
export function paramLabel(param) { return /^[A-Z]$/.test(param.code) ? 'Parameter ' + param.code : param.code; }
function isRoman(code) { return /^[IVXL]+$/.test(code); }

export function hrefFor(prog, area, param, ind, fileId, q) {
  const parts = [prog, area?.code, param?.code, ind?.code];
  if (fileId) parts.push('f', fileId);
  return href(parts, q);
}

export function docCountLabel(n) {
  return n === 0 ? 'No documents yet' : n === 1 ? '1 document' : n + ' documents';
}
