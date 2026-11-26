// Instant in-browser search over the loaded snapshots.
import { CONFIG } from './config.js';
import { normalize, tokenize } from './util.js';
import { areaLabel, paramLabel } from './model.js';

/** Pre-normalize everything once per snapshot load. */
export function buildIndex(snapshots) {
  const files = [];
  const indicators = [];
  CONFIG.programs.forEach((prog, progOrder) => {
    const snap = snapshots[prog.code];
    if (!snap) return;
    snap.areas.forEach((area, areaOrder) => {
      const areaCtx = normalize(`${areaLabel(area)} ${area.name}`);
      for (const param of area.parameters) {
        const paramCtx = normalize(`${paramLabel(param)} ${param.name}`);
        for (const ind of param.indicators) {
          const indText = normalize(`${ind.code} ${ind.text}`);
          const base = { prog: prog.code, progOrder, areaOrder, area, param, ind };
          // "General documents" rows are found through their files, not as indicator results.
          if (!ind.general) indicators.push({ ...base, nText: indText, nCtx: areaCtx + ' ' + paramCtx });
          for (const file of ind.files) {
            files.push({
              ...base,
              file,
              nName: normalize(file.name),
              nKw: (file.keywords || []).map(normalize),
              nCtx: `${indText} ${paramCtx} ${areaCtx} ${normalize(file.subfolder || '')}`,
            });
          }
        }
      }
    });
  });
  return { files, indicators };
}

/**
 * Every token must match somewhere (name, keywords, indicator, parameter, area).
 * Returns { total, groups: [{ prog, area, files: [...], indicators: [...] }] }.
 */
export function search(index, query, scope = 'all', limit = 200) {
  const tokens = tokenize(query);
  if (!index || !tokens.length) return { tokens, total: 0, shown: 0, groups: [] };
  const inScope = (e) => scope === 'all' || e.prog === scope;

  const fileHits = [];
  for (const e of index.files) {
    if (!inScope(e)) continue;
    const kwJoined = e.nKw.join(' | ');
    let score = 0;
    const kwMatched = new Set();
    let ok = true;
    for (const t of tokens) {
      const inName = e.nName.includes(t);
      const kwIdx = e.nKw.map((k, i) => (k.includes(t) ? i : -1)).filter((i) => i >= 0);
      const inCtx = e.nCtx.includes(t);
      if (!inName && !kwIdx.length && !inCtx && !kwJoined.includes(t)) { ok = false; break; }
      if (inName) score += 3;
      else if (kwIdx.length) { score += 2; kwIdx.forEach((i) => kwMatched.add(i)); }
      else score += 1;
    }
    if (!ok) continue;
    fileHits.push({
      ...e,
      score,
      matchedKeywords: [...kwMatched].map((i) => e.file.keywords[i]),
    });
  }

  const indHits = [];
  for (const e of index.indicators) {
    if (!inScope(e)) continue;
    const all = tokens.every((t) => e.nText.includes(t) || e.nCtx.includes(t));
    const any = tokens.some((t) => e.nText.includes(t));
    if (all && any) indHits.push(e);
  }

  fileHits.sort((a, b) =>
    a.progOrder - b.progOrder || a.areaOrder - b.areaOrder || b.score - a.score ||
    a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));

  const total = fileHits.length + indHits.length;
  const shownFiles = fileHits.slice(0, limit);
  const groups = new Map();
  const groupFor = (e) => {
    const key = e.prog + '|' + e.area.code;
    if (!groups.has(key)) groups.set(key, { key, prog: e.prog, progOrder: e.progOrder, areaOrder: e.areaOrder, area: e.area, files: [], indicators: [] });
    return groups.get(key);
  };
  shownFiles.forEach((e) => groupFor(e).files.push(e));
  indHits.slice(0, 60).forEach((e) => groupFor(e).indicators.push(e));

  const sorted = [...groups.values()].sort((a, b) => a.progOrder - b.progOrder || a.areaOrder - b.areaOrder);
  return { tokens, total, shown: shownFiles.length + Math.min(indHits.length, 60), more: fileHits.length > limit, groups: sorted };
}
