// Screens: login, choose program, choose area, workspace (file tree + content), search.
import { CONFIG } from './config.js';
import { esc, highlight, fileKind, fmtSize, fmtDate, plural } from './util.js';
import { href } from './router.js';
import { isStaff, lastPlace } from './api.js';
import {
  getProgram, findArea, findParam, findIndicator, countFiles, progress,
  areaLabel, paramLabel, hrefFor, docCountLabel, areaFileList,
  realAreas, shortCode, indLabel, placeLabel, areaTitle, findSection, otherArea,
} from './model.js';

// ── Small building blocks ───────────────────────────────────
export function crumbs(items) {
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items.map((p, i) => {
    const last = i === items.length - 1;
    return `<li>${last ? `<span aria-current="page">${esc(p.label)}</span>` : `<a href="${p.href}">${esc(p.label)}</a>`}</li>`;
  }).join('')}</ol></nav>`;
}

export function progressBadge(p, compact = false) {
  const cls = p.total && p.done === p.total ? 'complete' : p.done === 0 ? 'none' : '';
  return `<span class="progress ${cls}" title="${p.done} of ${p.total} indicators have at least one document">
    <span class="bar"><i style="width:${p.pct}%"></i></span>
    <span class="progress-text">${p.done}/${p.total}${compact ? '' : ' indicators'}</span></span>`;
}

function codeBadge(code, type) {
  return `<span class="badge ${type ? 'badge-' + esc(type) : ''}">${esc(code)}</span>`;
}

function pageHead(eyebrow, title, extra = '') {
  return `<header class="page-head">${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}
    <h2 class="page-title">${esc(title)}</h2>${extra}</header>`;
}

export function programName(prog, snap) { return snap?.program?.name || prog.name; }

function unavailable(prog, status) {
  if (!status || status.loading) {
    return `<div class="loading-block"><span class="spinner"></span> Loading ${esc(prog.name)}…</div>`;
  }
  if (status.noAccess) {
    return `<div class="card empty"><h3>${esc(prog.name)} is not open yet</h3>
      <p>This program has not been opened for viewing. Please ask the accreditation coordinator.</p>
      <p><a class="btn" href="#/">Back to programs</a></p></div>`;
  }
  // No snapshot here, so no Drive folder link: its URL only comes inside a staff snapshot.
  return `<div class="card error-card">
    <h3>${esc(prog.name)} is not available right now</h3>
    <p>${esc(status.error || 'The evidence list could not be loaded.')}</p>
  </div>`;
}

export function notFound(backHref = '#/', message = 'This page does not exist, or the item was moved.') {
  return `<div class="card empty"><h3>Not found</h3><p>${esc(message)}</p>
    <p><a class="btn" href="${backHref}">Go back</a></p></div>`;
}

/** Inline keyword editor (coordinators and admin). */
export function kwEditor(progCode, file, open = false) {
  return `<form class="kw-form" data-form="kw" data-prog="${esc(progCode)}" data-file-id="${esc(file.id)}" ${open ? '' : 'hidden'}>
    <label for="kw-${esc(file.id)}">Keywords <small>(separate with commas)</small></label>
    <div class="kw-row">
      <input id="kw-${esc(file.id)}" name="keywords" value="${esc((file.keywords || []).join(', '))}"
             maxlength="900" placeholder="e.g. BOR, resolution, approval" autocomplete="off">
      <button type="submit" class="btn btn-primary">Save</button>
    </div>
    <div class="kw-status" aria-live="polite"></div>
  </form>`;
}

function fileMeta(file) {
  const parts = [fileKind(file.mimeType).label, fmtSize(file.size), fmtDate(file.modified)].filter(Boolean);
  if (file.subfolder) parts.push('in “' + file.subfolder + '”');
  if (file.shortcut) parts.push('shortcut');
  return parts.map(esc).join(' · ');
}

function fileRow(progCode, file, viewHref, staff) {
  const kind = fileKind(file.mimeType);
  const kw = staff && file.keywords && file.keywords.length
    ? `<span class="file-kw">Keywords: ${esc(file.keywords.join(', '))}</span>` : '';
  return `<li class="file-item">
    <div class="file-row">
      <a class="file-link" href="${viewHref}">
        <span class="kind ${kind.cls}">${kind.label}</span>
        <span class="file-main">
          <span class="file-name clamp" title="${esc(file.name)}">${esc(file.name)}</span>
          <span class="file-meta">${fileMeta(file)}</span>${kw}
        </span>
      </a>
      ${staff ? `<button type="button" class="btn btn-ghost btn-sm" data-action="kw-toggle" aria-label="Edit keywords for ${esc(file.name)}">✎ Keywords</button>` : ''}
    </div>
    ${staff ? kwEditor(progCode, file) : ''}
  </li>`;
}

// ── Login ───────────────────────────────────────────────────
export function renderLogin() {
  return `<div class="login-wrap">
    <div class="card login-card">
      <div class="login-logos">${CONFIG.logos.map((l) => `<img src="${esc(l.src)}" alt="${esc(l.alt)}" width="64" height="64">`).join('')}</div>
      <h2 class="page-title">Welcome</h2>
      <p class="muted">Enter your 6-digit PIN to open the accreditation evidence.</p>
      <form data-form="login" class="form" autocomplete="off">
        <label class="sr-only" for="pin">PIN</label>
        <input id="pin" name="pin" class="pin-input" type="password" inputmode="numeric" pattern="[0-9]{6}"
               maxlength="6" autocomplete="off" required placeholder="••••••" aria-describedby="pinHelp">
        <button type="submit" class="btn btn-primary btn-block">Log in</button>
        <div class="form-status" aria-live="polite"></div>
      </form>
      <p class="muted small" id="pinHelp">Each accreditor has a personal PIN; coordinators use the coordinator PIN.
        If you don't have one, ask the accreditation coordinator.</p>
    </div>
  </div>`;
}

// ── Home: one card per program ──────────────────────────────
const ICONS = {
  CR: '<path d="M9 4h6v3H9z"/><path d="M15 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  PPP: '<path d="M4 20h16"/><path d="M7 16v-5"/><path d="M12 16V7"/><path d="M17 16v-8"/>',
  SSR: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/><path d="M9 8h7M9 12h5"/>',
};
const icon = (key) => `<svg class="ptile-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[key]}</svg>`;

/** A section opens its tree; with just one document it opens that document directly. */
function sectionHref(progCode, area) {
  const list = areaFileList(area);
  return list.length === 1 ? hrefFor(progCode, area, list[0].param, list[0].ind, list[0].file.id) : hrefFor(progCode, area);
}

function programTile(key, title, sub, link, meta) {
  const inner = `${icon(key)}<span class="ptile-text"><span class="ptile-title">${esc(title)}</span>
      ${sub ? `<span class="ptile-sub">${esc(sub)}</span>` : ''}</span>`;
  if (!link) {
    return `<li><span class="ptile is-off" aria-disabled="true">${inner}<span class="ptile-meta">Not available yet</span></span></li>`;
  }
  return `<li><a class="ptile" href="${link}">${inner}<span class="ptile-meta">${esc(meta)} <span aria-hidden="true">→</span></span></a></li>`;
}

function programCard(prog, snap) {
  const cr = findSection(snap, 'CR');
  const ppp = findSection(snap, 'PPP');
  const ssi = findSection(snap, 'SSI');
  const areas = realAreas(snap);
  const ssrDocs = areas.reduce((n, a) => n + countFiles(a), ssi ? countFiles(ssi) : 0);
  const ssrSub = (ssi ? 'Instrument + ' : '') + plural(areas.length, 'area');
  const other = otherArea(snap);
  const full = snap.program?.name && snap.program.name !== prog.name ? snap.program.name : '';
  return `<li><article class="card program-card">
      <header class="pc-head">
        <span class="pc-code">${esc(prog.name)}</span>
        <div class="pc-title">
          ${full ? `<h3>${esc(full)}</h3>` : `<h3 class="sr-only">${esc(prog.name)}</h3>`}
          <p class="muted small">${plural(countFiles(snap), 'document')}</p>
        </div>
      </header>
      <ul class="ptiles">
        ${programTile('CR', 'Compliance Report', '', cr && sectionHref(prog.code, cr), cr && docCountLabel(countFiles(cr)))}
        ${programTile('PPP', 'PPP', 'Program Performance Profile', ppp && sectionHref(prog.code, ppp), ppp && docCountLabel(countFiles(ppp)))}
        ${programTile('SSR', 'Self-Survey Report', ssrSub, (ssi || areas.length) && href([prog.code]), docCountLabel(ssrDocs))}
      </ul>
      ${other ? `<a class="pc-other" href="${hrefFor(prog.code, other)}">Other documents · ${countFiles(other)}</a>` : ''}
    </article></li>`;
}

export function renderHome(state) {
  const visible = CONFIG.programs.filter((p) => !state.status[p.code]?.noAccess);
  const cards = visible.map((prog) => {
    const snap = state.snaps[prog.code];
    return snap ? programCard(prog, snap) : `<li>${unavailable(prog, state.status[prog.code])}</li>`;
  }).join('');

  const last = lastPlace.get();
  const lastSnap = last && state.snaps[last.prog];
  const lastArea = lastSnap && findArea(lastSnap, last.area);
  const resume = lastArea ? `<a class="resume" href="${hrefFor(last.prog, lastArea)}">
      <span>Continue where you left off:</span>
      <strong>${esc(programName(getProgram(last.prog), lastSnap))} › ${esc(areaLabel(lastArea))}</strong> →</a>` : '';

  return `${resume}${pageHead('', 'Choose a program')}
    ${visible.length ? `<ul class="program-grid">${cards}</ul>`
      : `<div class="card empty"><p>No program is open for viewing yet. Please ask the accreditation coordinator.</p></div>`}
    <p class="muted small">Tip: use the search box above to find any document by name, keyword, or indicator.</p>`;
}

// ── Self-Survey Report: the instrument + Area I … X ─────────
export function renderProgram(state, route) {
  const prog = getProgram(route.prog);
  if (!prog) return notFound();
  const snap = state.snaps[prog.code];
  if (!snap) return unavailable(prog, state.status[prog.code]);
  const ssi = findSection(snap, 'SSI');
  const cards = [...(ssi ? [ssi] : []), ...realAreas(snap)].map((area) => `<li><a class="card area-card ${area.section ? 'area-card-ssi' : ''}" href="${hrefFor(prog.code, area)}">
      <span class="badge badge-area">${esc(shortCode(area))}</span>
      <span class="area-card-main">
        <span class="area-card-label">${esc(area.section ? 'Instrument' : areaLabel(area))}</span>
        <span class="area-card-name">${esc(area.name)}</span>
        <span class="muted small">${docCountLabel(countFiles(area))}</span>
      </span></a></li>`).join('');
  return crumbs([{ label: 'Programs', href: '#/' }, { label: programName(prog, snap) + ' · Self-Survey Report', href: href([prog.code]) }]) +
    pageHead(esc(programName(prog, snap)), 'Self-Survey Report', '<p class="muted">Choose the Self-Survey Instrument or an area.</p>') +
    (cards ? `<ul class="area-grid">${cards}</ul>` : '<div class="card empty"><p>No areas are open for viewing.</p></div>');
}

// ── Workspace: tree (left) + content (right) ────────────────
/** Returns { html, workspace } — workspace=false when the area can't be shown (plain page instead). */
export function renderWorkspace(state, route, searchHtml) {
  const prog = getProgram(route.prog);
  if (!prog) return { html: notFound(), workspace: false };
  const snap = state.snaps[prog.code];
  if (!snap) return { html: unavailable(prog, state.status[prog.code]), workspace: false };
  const area = findArea(snap, route.area);
  if (!area) return { html: notFound(href([prog.code]), 'This area is not available. It may not be open for viewing.'), workspace: false };

  const viewer = !searchHtml && !!route.fileId;
  const content = searchHtml || renderContent(state, prog, snap, area, route);
  const html = `<div class="workspace" data-area="${esc(prog.code + '/' + area.code)}">
    <aside class="tree-pane" id="treePane" aria-label="Documents in ${esc(areaLabel(area))}">
      <div class="tree-head">
        <button type="button" class="btn tree-close" data-action="tree-close">✕ Close list of files</button>
        <a class="tree-area" href="${hrefFor(prog.code, area)}" title="${esc(area.name)}">
          <span class="badge badge-area">${esc(shortCode(area))}</span>
          <span class="tree-area-name">${esc(area.name)}</span>
        </a>
        <div class="tree-tools">
          <button type="button" class="icon-btn" data-action="tree-expand" title="Expand all" aria-label="Expand all">⊞</button>
          <button type="button" class="icon-btn" data-action="tree-collapse" title="Collapse all" aria-label="Collapse all">⊟</button>
          ${checkNowButton(prog)}
          ${isStaff() && area.section && area.folderId ? `<a class="btn btn-sm" href="https://drive.google.com/drive/folders/${esc(area.folderId)}" target="_blank" rel="noopener"
              title="Add files to “${esc(area.name)}”: opens its folder in Google Drive">＋ Add files</a>` : ''}
        </div>
        ${treeStaffTools()}
      </div>
      <div class="tree-scroll" id="treeScroll">
        <nav class="tree" id="tree">${renderTree(state, prog, area, route)}</nav>
      </div>
    </aside>
    <div class="tree-backdrop" data-action="tree-close"></div>
    <button type="button" class="tree-rail" data-action="tree-toggle" aria-controls="treePane"
            title="Show the list of files" aria-label="Show the list of files">
      <span class="rail-icon" aria-hidden="true">☰</span><span class="rail-text">Show files</span>
    </button>
    <section class="content-pane ${viewer ? 'has-viewer' : ''} ${!viewer && !searchHtml ? 'is-empty' : ''}" id="contentPane">${content}</section>
  </div>`;
  return { html, workspace: true };
}

export function nodeKey(prog, area, ...rest) { return [prog, area, ...rest].join('/'); }

function renderTree(state, prog, area, route) {
  const staff = isStaff();
  const isOpen = (key, onPath) => (onPath ? !state.closedNodes.has(key) : state.openNodes.has(key));
  const params = area.parameters.map((param) => {
    const onP = route.param === param.code;
    // An Area folder's own files: one "General documents" row at the top, no parameter level.
    // A section (Compliance Report, PPP, …): its files and subfolders directly, no row at all.
    if (param.general) return param.indicators.map((ind) => indRow(prog, area, param, ind, route, onP, isOpen, staff)).join('');
    const pk = nodeKey(prog.code, area.code, param.code);
    const inds = param.indicators.map((ind) => indRow(prog, area, param, ind, route, onP, isOpen, staff)).join('');
    const paramActive = onP && !route.ind;
    const pp = progress(param);
    return `<li class="tn-param">
      <details data-node="${esc(pk)}" ${isOpen(pk, onP) ? 'open' : ''}>
        <summary><a class="tn-link ${paramActive ? 'active' : ''}" href="${hrefFor(prog.code, area, param)}"
            title="${esc(paramLabel(param) + ' · ' + (param.name || ''))}" ${paramActive ? 'aria-current="page"' : ''}>
          <span class="tn-code tn-param-code">${esc(param.code)}</span>
          <span class="tn-text">${esc(param.name || paramLabel(param))}</span>
          <span class="tn-count" title="${staff ? `${pp.done} of ${pp.total} indicators have documents` : ''}">${staff ? `${pp.done}/${pp.total}` : countFiles(param)}</span>
        </a></summary>
        <ul>${inds}</ul>
      </details></li>`;
  }).join('');
  return params ? `<ul class="tree-root ${area.section ? 'tree-flat' : ''}">${params}</ul>` : '<p class="tn-none">No parameters found.</p>';
}

/** One indicator (or "General documents") row with its files and subfolders. */
function indRow(prog, area, param, ind, route, onP, isOpen, staff) {
  const ik = nodeKey(prog.code, area.code, param.code, ind.code);
  const onI = onP && route.ind === ind.code;
  const fileLink = (f) => {
    const active = onI && route.fileId === f.id;
    const kind = fileKind(f.mimeType);
    return `<li><a class="tn-link tn-file ${active ? 'active' : ''}" href="${hrefFor(prog.code, area, param, ind, f.id)}"
        title="${esc(f.name)}" ${active ? 'aria-current="page"' : ''}>
      <span class="kind kind-xs ${kind.cls}">${kind.label}</span><span class="tn-text">${esc(f.name)}</span></a></li>`;
  };
  const files = renderFolder(subfolderTree(ind.files, ind.subfolders), ik, fileLink, (fid) => onI && route.fileId === fid, isOpen, staff);
  if (ind.inline) return files || '<li><p class="tn-none">No documents yet</p></li>';
  const indActive = onI && !route.fileId;
  const n = ind.files.length;
  const title = ind.general ? indLabel(ind) : ind.code + ' · ' + (ind.text || '');
  return `<li class="tn-ind ${n ? '' : 'empty'} ${ind.general ? 'tn-general' : ''}">
    <details data-node="${esc(ik)}" ${isOpen(ik, onI) ? 'open' : ''}>
      <summary><a class="tn-link ${indActive ? 'active' : ''}" href="${hrefFor(prog.code, area, param, ind)}"
          title="${esc(title)}" ${indActive ? 'aria-current="page"' : ''}>
        <span class="tn-code tn-${esc(ind.type || 'x')}">${esc(shortCode(ind))}</span>
        <span class="tn-text">${esc(ind.text || ind.code)}</span>
        ${staff && !n ? '<span class="tn-missing" title="No documents yet">●</span>' : `<span class="tn-count">${n}</span>`}
      </a>${staff ? addToDrive(ind.folderId, indLabel(ind)) : ''}</summary>
      ${files ? `<ul>${files}</ul>` : '<p class="tn-none">No documents yet</p>'}
    </details></li>`;
}

/** Staff "＋" on a tree row: opens that exact Drive folder in a new tab to drop files into. */
function addToDrive(folderId, name) {
  if (!folderId) return '';
  return `<a class="tn-add" href="https://drive.google.com/drive/folders/${esc(folderId)}" target="_blank" rel="noopener"
       title="Add files to “${esc(name)}”: opens this folder in Google Drive" aria-label="Add files to ${esc(name)} (opens Google Drive)">＋</a>`;
}

/** Separator the backend puts between nested subfolder names in `file.subfolder`. */
const SUB_SEP = ' › ';

/**
 * Group an indicator's files by their Drive subfolder path: { files, folders: Map<name, node> }.
 * `subfolders` (every subfolder, from the backend) adds the folders that have no files yet.
 * Staff get { path, id } entries (id = Drive folder, for "add files"); accreditors get bare paths.
 */
function subfolderTree(files, subfolders = []) {
  const root = { files: [], folders: new Map() };
  const walk = (path) => {
    let node = root;
    for (const name of path ? path.split(SUB_SEP) : []) {
      if (!node.folders.has(name)) node.folders.set(name, { files: [], folders: new Map(), id: null });
      node = node.folders.get(name);
    }
    return node;
  };
  subfolders.forEach((s) => {
    const node = walk(typeof s === 'string' ? s : s.path);
    if (s && s.id) node.id = s.id;
  });
  for (const f of files) walk(f.subfolder).files.push(f);
  return root;
}

function folderFileIds(node, out = []) {
  node.files.forEach((f) => out.push(f.id));
  node.folders.forEach((child) => folderFileIds(child, out));
  return out;
}

/** Subfolders first (natural order, like Drive), then the files directly in this folder. */
function renderFolder(node, key, fileLink, isActive, isOpen, staff) {
  const names = [...node.folders.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const folders = names.map((name) => {
    const child = node.folders.get(name);
    const fk = `${key}/~${name}`;
    const ids = folderFileIds(child);
    const inner = renderFolder(child, fk, fileLink, isActive, isOpen, staff);
    const add = staff ? addToDrive(child.id, name) : '';
    return `<li class="tn-folder ${ids.length ? '' : 'empty'}">
      <details data-node="${esc(fk)}" ${isOpen(fk, ids.some(isActive)) ? 'open' : ''}>
        <summary><span class="tn-link" title="${esc(name)}">
          <span class="tn-folder-icon" aria-hidden="true">📁</span>
          <span class="tn-text">${esc(name)}</span>
          <span class="tn-count">${ids.length}</span>
        </span>${add}</summary>
        ${inner ? `<ul>${inner}</ul>` : '<p class="tn-none">No documents yet</p>'}
      </details></li>`;
  }).join('');
  return folders + node.files.map(fileLink).join('');
}

/** The viewer pane stays empty until a document is picked; selecting a folder only opens it in the tree. */
function renderContent(state, prog, snap, area, route) {
  if (route.fileId) return renderViewer(state, prog, snap, area, route);
  return `<p class="viewer-empty">Select a document to view it</p>`;
}

/** Coordinator/admin: rescan Drive now. Sits on the same row as Expand/Collapse all. */
function checkNowButton(prog) {
  if (!isStaff()) return '';
  return `<button type="button" class="btn btn-sm tree-check" data-action="check-now" data-prog="${esc(prog.code)}"
        title="Rescan Google Drive now, right after uploading">↻ Check now</button>`;
}

/** Coordinator/admin status line under the tree tools.
 *  Adding files is done with the ＋ on each indicator and subfolder row in the tree. */
function treeStaffTools() {
  if (!isStaff()) return '';
  return `<div class="tree-staff">
    <span class="form-status" id="chk-status" aria-live="polite"></span>
  </div>`;
}

function renderViewer(state, prog, snap, area, route) {
  const list = areaFileList(area);
  const idx = list.findIndex((e) => e.param.code === route.param && e.ind.code === route.ind && e.file.id === route.fileId);
  if (idx === -1) {
    const param = findParam(area, route.param);
    const ind = findIndicator(param, route.ind);
    return notFound(ind ? hrefFor(prog.code, area, param, ind) : hrefFor(prog.code, area),
      'This document is no longer here. It may have been moved, renamed, or deleted.');
  }
  const { param, ind, file } = list[idx];
  const staff = isStaff();
  const sh = CONFIG.viewerShield || {};
  const shield = staff ? '' : `<div class="viewer-shield" aria-hidden="true"
      style="top:${Number(sh.top) || 0}px;right:${Number(sh.right) || 0}px;width:${Number(sh.width) || 80}px;height:${Number(sh.height) || 64}px"></div>`;
  const watermark = !staff && state.watermark ? '<div class="watermark" aria-hidden="true"></div>' : '';
  const body = file.previewUrl
    ? `<div class="viewer-frame" data-file="${esc(file.id)}">
        <div class="viewer-loading"><span class="spinner"></span><span>Loading document…</span>
          <span class="viewer-slow" hidden>Large files can take a while.${staff && file.viewUrl ? ` <a href="${esc(file.viewUrl)}" target="_blank" rel="noopener">Open in new tab</a>` : ''}</span></div>
        <iframe src="${esc(file.previewUrl)}" title="${esc(file.name)}" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>
        ${shield}${watermark}
      </div>`
    : `<div class="card empty viewer-frame viewer-none" data-file="${esc(file.id)}"><p>This type of file cannot be previewed here.</p>
        ${staff && file.viewUrl ? `<p><a class="btn btn-primary" href="${esc(file.viewUrl)}" target="_blank" rel="noopener">Open in new tab ↗</a></p>`
          : '<p class="muted">Please ask the area coordinator to show it to you.</p>'}</div>`;
  return `<div class="viewer">
    <div class="viewer-bar">
      <span class="viewer-name" title="${esc(file.name)}">${esc(file.name)}</span>
      <span class="viewer-path" title="${esc(ind.text || '')}">${esc(placeLabel(param, ind))}</span>
      ${staff ? `<div class="viewer-kw" data-kw-scope>
        <button type="button" class="btn btn-ghost btn-sm" data-action="kw-toggle" aria-label="Edit keywords for ${esc(file.name)}">✎ Keywords</button>
        ${kwEditor(prog.code, file)}
      </div>` : ''}
    </div>
    ${body}
  </div>`;
}

/** Repeating diagonal text, as a CSS background-image value. */
export function watermarkImage(text) {
  const t = String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200">` +
    `<text x="180" y="100" text-anchor="middle" transform="rotate(-24 180 100)" ` +
    `font-family="Arial, sans-serif" font-size="15" font-weight="bold" fill="rgb(0,0,0)" fill-opacity="0.10">${t}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// ── Search results ──────────────────────────────────────────
export function renderSearch(state, route, results, scope) {
  const q = route.q.trim();
  const multi = scope === 'all' && CONFIG.programs.length > 1;
  const scopeName = scope !== 'all' ? programName(getProgram(scope), state.snaps[scope]) : '';
  const where = scopeName ? ` in ${esc(scopeName)}` : '';
  if (!results.total) {
    return `<div class="search-summary">No results for “${esc(q)}”${where}</div>
      <div class="card empty"><p>No documents match. Try fewer words${scopeName ? ', or search from the Home page to look in every program' : ''}.</p>
      <p><button type="button" class="btn" data-action="clear-search">Clear search</button></p></div>`;
  }
  const groups = results.groups.map((g) => {
    const prog = getProgram(g.prog);
    const progName = programName(prog, state.snaps[g.prog]);
    const files = g.files.map((e) => {
      const kind = fileKind(e.file.mimeType);
      const kwLine = e.matchedKeywords.length
        ? `<span class="match-kw">Matched keyword: ${e.matchedKeywords.map((k) => highlight(k, results.tokens)).join(', ')}</span>` : '';
      const pathText = `${multi ? progName + ' › ' : ''}${placeLabel(e.param, e.ind)}`;
      return `<li class="result">
        <a class="result-file" href="${hrefFor(g.prog, e.area, e.param, e.ind, e.file.id)}">
          <span class="kind ${kind.cls}">${kind.label}</span>
          <span class="file-name clamp" title="${esc(e.file.name)}">${highlight(e.file.name, results.tokens)}</span>
        </a>
        ${kwLine}
        <a class="result-path" href="${hrefFor(g.prog, e.area, e.param, e.ind)}" title="${esc(e.ind.text)}">${esc(pathText)}</a>
      </li>`;
    }).join('');
    const inds = g.indicators.map((e) => `<li class="result result-ind">
        <a class="result-file" href="${hrefFor(g.prog, e.area, e.param, e.ind)}">
          ${codeBadge(e.ind.code, e.ind.type)}
          <span class="clamp">${highlight(e.ind.text || e.ind.code, results.tokens)}</span>
        </a>
        <span class="result-path">${esc(`${multi ? progName + ' › ' : ''}${paramLabel(e.param)}`)} · ${docCountLabel(e.ind.files.length)}</span>
      </li>`).join('');
    return `<section class="result-group">
      <h3 class="group-title">${multi ? esc(progName) + ' · ' : ''}${esc(areaTitle(g.area))}</h3>
      <ul class="results">${files}${inds}</ul>
    </section>`;
  }).join('');
  return `<div class="search-summary">${plural(results.total, 'result')} for “${esc(q)}”${where}
      <button type="button" class="btn btn-ghost btn-sm" data-action="clear-search">× Clear</button></div>
    ${groups}
    ${results.more ? `<p class="center"><button type="button" class="btn" data-action="show-more">Show more results</button></p>` : ''}`;
}
