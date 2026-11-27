// All files (coordinators and admin): every document of every program in one list, the picked
// document shown beside it. Built from the search index the browser already has, so it makes
// no extra calls to Apps Script or Google Drive.
import { CONFIG } from './config.js';
import { esc, highlight, fileKind, fmtDate, tokenize } from './util.js';
import { getProgram, areaLabel, areaTitle, placeLabel, hrefFor, filesHref, fileFolderId } from './model.js';
import { programName, kwEditor, viewerFrame, notFound } from './views.js';

const PAGE = 200;

/** Filter state and page (0 = first), kept in memory for the tab so coming back to the list keeps them. */
export const defaultFilters = () => ({ q: '', prog: 'all', section: 'all', kind: 'all', sort: 'tree', page: 0 });

const KINDS = [
  ['PDF', 'PDF'], ['DOC', 'Documents'], ['XLS', 'Spreadsheets'], ['PPT', 'Presentations'],
  ['IMG', 'Images'], ['VID', 'Video and audio'], ['OTHER', 'Other types'],
];
const kindKey = (mime) => {
  const k = fileKind(mime).label;
  return KINDS.some(([key]) => key === k) ? k : 'OTHER';
};

const SORTS = [['tree', 'Folder order'], ['name', 'Name A–Z'], ['new', 'Newest first']];

/** Compliance Report / PPP cards → their group, the Actual Self-Survey Report, Area I … X, Other documents, Reference folders. */
function sectionKey(area) {
  if (area.reference) return 'R:' + area.name;
  if (area.group) return 'G:' + area.group;
  if (area.section) return 'S:' + area.code;
  if (area.general) return 'OTHER';
  return 'A:' + area.code;
}

/** Section menu entries in the order the programs show them, merged across programs. */
function sectionOptions(state) {
  const groups = new Map(), sections = new Map(), areas = new Map(), refs = new Map();
  let other = false;
  for (const prog of CONFIG.programs) {
    const snap = state.snaps[prog.code];
    if (!snap) continue;
    for (const g of snap.groups || []) if (!groups.has('G:' + g.code)) groups.set('G:' + g.code, g.name);
    for (const r of snap.referenceAreas || []) if (!refs.has(sectionKey(r))) refs.set(sectionKey(r), 'Reference: ' + r.name);
    for (const a of snap.areas || []) {
      const key = sectionKey(a);
      if (a.group) continue;
      if (a.section) { if (!sections.has(key)) sections.set(key, a.name); }
      else if (a.general) other = true;
      else if (!areas.has(key)) areas.set(key, areaLabel(a));
    }
  }
  const out = [...groups, ...sections, ...areas];
  if (other) out.push(['OTHER', 'Other documents']);
  return out.concat([...refs]);
}

/** "Area I › Parameter A › S.1 › Students", "Compliance Report › Area II", "Actual Self-Survey Report", "Reference › CHED Memos". */
function placeOf(e) {
  const a = e.area;
  const parts = [a.reference ? `Reference › ${a.name}` : a.group ? `${a.groupName} › ${areaLabel(a)}` : areaLabel(a)];
  if (!e.ind.inline && !a.general) parts.push(placeLabel(e.param, e.ind));
  if (e.file.subfolder) parts.push(e.file.subfolder);
  return parts.join(' › ');
}

function filtered(state) {
  const f = state.files;
  const tokens = tokenize(f.q);
  const hits = (state.index?.files || []).filter((e) => {
    if (f.prog !== 'all' && e.prog !== f.prog) return false;
    if (f.section !== 'all' && sectionKey(e.area) !== f.section) return false;
    if (f.kind !== 'all' && kindKey(e.file.mimeType) !== f.kind) return false;
    // Same rule as the search box: every word must be in the name, a keyword, or the location.
    return tokens.every((t) => e.nName.includes(t) || e.nKw.some((k) => k.includes(t)) || e.nCtx.includes(t));
  });
  if (f.sort === 'name') {
    hits.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }));
  } else if (f.sort === 'new') {
    hits.sort((a, b) => String(b.file.modified || '').localeCompare(String(a.file.modified || '')));
  }
  return { hits, tokens };
}

const sameEntry = (e, route) => e.prog === route.prog && e.area.code === route.area &&
  e.param.code === route.param && e.ind.code === route.ind && e.file.id === route.fileId;

/** The document the route points at; falls back to the same file elsewhere in that program (e.g. it was moved). */
export function currentEntry(state, route) {
  if (!route?.fileId) return null;
  const files = state.index?.files || [];
  return files.find((e) => sameEntry(e, route)) ||
    files.find((e) => e.prog === route.prog && e.file.id === route.fileId) || null;
}

const driveFolder = (id) => 'https://drive.google.com/drive/folders/' + encodeURIComponent(id);
const count = (n) => n.toLocaleString('en-PH');

function progNames(state) {
  const names = {};
  for (const p of CONFIG.programs) names[p.code] = programName(p, state.snaps[p.code]);
  return names;
}

function row(e, active, tokens, names, multi) {
  const kind = fileKind(e.file.mimeType);
  const folder = fileFolderId(e.ind, e.file);
  const date = fmtDate(e.file.modified);
  const where = placeOf(e);
  return `<li class="fl-item ${active ? 'active' : ''}">
    <a class="fl-link" href="${filesHref(e.prog, e.area, e.param, e.ind, e.file.id)}"
        title="${esc(e.file.name + '\n' + names[e.prog] + ' · ' + areaTitle(e.area) + (e.ind.inline || e.area.general ? '' : ' › ' + (e.ind.text || e.ind.code)))}"
        ${active ? 'aria-current="page"' : ''}>
      <span class="kind kind-xs ${kind.cls}">${kind.label}</span>
      <span class="fl-main">
        <span class="fl-name">${highlight(e.file.name, tokens)}</span>
        <span class="fl-meta">${multi ? `<b>${esc(names[e.prog])}</b> · ` : ''}${highlight(where, tokens)}${date ? ' · ' + esc(date) : ''}</span>
      </span>
    </a>
    ${folder ? `<a class="tn-add fl-drive" href="${driveFolder(folder)}" target="_blank" rel="noopener"
        title="Open the folder of “${esc(e.file.name)}” in Google Drive" aria-label="Open the folder of ${esc(e.file.name)} in Google Drive">📁↗</a>` : ''}
  </li>`;
}

/** ‹ Previous · Page 2 of 7 · Next › (only when there is more than one page). */
function pager(page, pages) {
  if (pages < 2) return '';
  const btn = (to, text, label) => `<button type="button" class="btn btn-sm" data-action="files-page" data-page="${to}"
      aria-label="${label}" ${to < 0 || to >= pages ? 'disabled' : ''}>${text}</button>`;
  return `<nav class="fl-pager" aria-label="Pages of files">
    ${btn(page - 1, '‹ Previous', 'Previous page')}
    <span>Page ${count(page + 1)} of ${count(pages)}</span>
    ${btn(page + 1, 'Next ›', 'Next page')}
  </nav>`;
}

/** The list, its pager and the count line (redrawn on their own while the user types in the filter). */
function listParts(state, route) {
  const all = state.index?.files || [];
  if (!all.length) {
    const loading = CONFIG.programs.some((p) => state.status[p.code]?.loading);
    return {
      count: '',
      list: loading ? '<div class="loading-block"><span class="spinner"></span> Loading…</div>'
        : '<p class="fl-empty">No documents yet.</p>',
    };
  }
  const { hits, tokens } = filtered(state);
  const pages = Math.max(1, Math.ceil(hits.length / PAGE));
  // Fewer files than before (new filter, or files removed in Drive): stay within the last page.
  const page = state.files.page = Math.min(Math.max(0, state.files.page), pages - 1);
  const start = page * PAGE;
  const shown = hits.slice(start, start + PAGE);
  const names = progNames(state);
  const multi = state.files.prog === 'all' && CONFIG.programs.filter((p) => state.snaps[p.code]).length > 1;
  const word = hits.length === 1 ? 'file' : 'files';
  const countText = `${count(hits.length)} ${word}` + (pages > 1 ? ` · ${count(start + 1)}–${count(start + shown.length)}` : '');
  if (!hits.length) {
    return {
      count: countText,
      list: `<p class="fl-empty">No files match these filters.
        <button type="button" class="linklike" data-action="files-reset">Clear filters</button></p>`,
    };
  }
  const rows = shown.map((e) => row(e, sameEntry(e, route), tokens, names, multi)).join('');
  const nav = pager(page, pages);
  return { count: countText, list: `${nav}<ul class="fl">${rows}</ul>${nav}` };
}

function select(name, label, options, value) {
  return `<label><span class="sr-only">${esc(label)}</span>
    <select data-files-filter="${name}" aria-label="${esc(label)}">
      ${options.map(([v, text]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}
    </select></label>`;
}

function filtersHtml(state) {
  const f = state.files;
  const progs = CONFIG.programs.filter((p) => state.snaps[p.code]);
  const names = progNames(state);
  return `<div class="files-filters">
    <label class="ff-q"><span class="sr-only">Filter files</span>
      <input type="search" data-files-filter="q" value="${esc(f.q)}" placeholder="Filter by name, keyword, indicator…"
             autocomplete="off" enterkeyhint="search" aria-label="Filter files"></label>
    ${progs.length > 1 ? select('prog', 'Program', [['all', 'All programs'], ...progs.map((p) => [p.code, names[p.code]])], f.prog) : ''}
    ${select('section', 'Section', [['all', 'All sections'], ...sectionOptions(state)], f.section)}
    ${select('kind', 'File type', [['all', 'All types'], ...KINDS], f.kind)}
    ${select('sort', 'Sort', SORTS, f.sort)}
  </div>`;
}

/** Right side: the picked document with links to its Drive folder, the file itself, and keywords. */
function previewHtml(state, route) {
  if (!route.fileId) return '<p class="viewer-empty">Select a document to view it</p>';
  const e = currentEntry(state, route);
  if (!e) return notFound('#/files', 'This document is no longer here. It may have been moved, renamed, or deleted.');
  const folder = fileFolderId(e.ind, e.file);
  const name = programName(getProgram(e.prog), state.snaps[e.prog]);
  return `<div class="viewer">
    <div class="viewer-bar files-bar">
      <span class="viewer-name" title="${esc(e.file.name)}">${esc(e.file.name)}</span>
      ${e.reference // Reference folders have no area page
        ? `<span class="viewer-path">${esc(name + ' · ' + placeOf(e))}</span>`
        : `<a class="viewer-path" href="${hrefFor(e.prog, e.area, e.param, e.ind, e.file.id)}"
            title="Open in its area page">${esc(name + ' · ' + placeOf(e))}</a>`}
      <div class="viewer-kw viewer-actions" data-kw-scope>
        ${folder ? `<a class="btn btn-ghost btn-sm" href="${driveFolder(folder)}" target="_blank" rel="noopener"
            title="Open the Google Drive folder this file is in">📁 Open folder in Drive ↗</a>` : ''}
        ${e.file.viewUrl ? `<a class="btn btn-ghost btn-sm" href="${esc(e.file.viewUrl)}" target="_blank" rel="noopener"
            title="Open this file in Google Drive">Open file ↗</a>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-action="kw-toggle" aria-label="Edit keywords for ${esc(e.file.name)}">✎ Keywords</button>
        ${kwEditor(e.prog, e.file)}
      </div>
    </div>
    ${viewerFrame(state, e.file)}
  </div>`;
}

/** Same layout (and class names) as the area page: list on the left, document on the right. */
export function renderFiles(state, route) {
  const viewer = !!route.fileId;
  // A document opened from a link or with Back: show the page of the list it is on.
  if (viewer) {
    const at = filtered(state).hits.findIndex((e) => sameEntry(e, route));
    if (at >= 0) state.files.page = Math.floor(at / PAGE);
  }
  const { list, count: countText } = listParts(state, route);
  const html = `<div class="workspace files-ws" data-area="files">
    <aside class="tree-pane" id="treePane" aria-label="All files">
      <div class="tree-head">
        <button type="button" class="btn tree-close" data-action="tree-close">✕ Close list of files</button>
        <div class="tree-area">
          <span class="badge badge-area">ALL</span>
          <span class="tree-area-name">All files</span>
          <span class="files-count" id="filesCount" aria-live="polite">${countText}</span>
        </div>
        ${filtersHtml(state)}
      </div>
      <div class="tree-scroll" id="treeScroll"><div id="filesList">${list}</div></div>
    </aside>
    <div class="tree-backdrop" data-action="tree-close"></div>
    <button type="button" class="tree-rail" data-action="tree-toggle" aria-controls="treePane"
            title="Show the list of files" aria-label="Show the list of files">
      <span class="rail-icon" aria-hidden="true">☰</span><span class="rail-text">Show files</span>
    </button>
    <section class="content-pane ${viewer ? 'has-viewer' : 'is-empty'}" id="contentPane">${previewHtml(state, route)}</section>
  </div>`;
  return { html, workspace: true };
}

/** Redraw only the list and its count, so the filter box keeps focus. `toTop` after a filter change. */
export function redrawList(app, toTop = false) {
  const box = document.getElementById('filesList');
  if (!box) return;
  const { list, count: countText } = listParts(app.state, app.state.route);
  box.innerHTML = list;
  const c = document.getElementById('filesCount');
  if (c) c.textContent = countText;
  if (toTop) document.getElementById('treeScroll')?.scrollTo(0, 0);
}

export function setFilter(state, key, value) {
  if (!(key in state.files) || key === 'page') return;
  state.files[key] = value;
  state.files.page = 0;
}

export function setPage(state, page) {
  if (Number.isInteger(page) && page >= 0) state.files.page = page; // listParts clamps it to the last page
}

export function resetFilters(state) {
  state.files = { ...defaultFilters(), sort: state.files.sort };
}
