// Screens: login, choose program, choose area, workspace (file tree + content), search.
import { CONFIG } from './config.js';
import { esc, highlight, fileKind, fmtSize, fmtDate, plural, normalize } from './util.js';
import { href } from './router.js';
import { isStaff, lastPlace } from './api.js';
import {
  getProgram, findArea, findParam, findIndicator, countFiles, progress,
  areaLabel, paramLabel, hrefFor, docCountLabel, areaFileList,
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
  const drive = isStaff()
    ? `<p><a class="btn" href="${esc(prog.rootFolderUrl)}" target="_blank" rel="noopener">Open the ${esc(prog.name)} folder in Google Drive</a></p>` : '';
  return `<div class="card error-card">
    <h3>${esc(prog.name)} is not available right now</h3>
    <p>${esc(status.error || 'The evidence list could not be loaded.')}</p>${drive}
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

/** Files outside any indicator folder: coordinators/admin only (accreditors never receive them). */
function looseSection(files) {
  if (!isStaff() || !files || !files.length) return '';
  return `<section class="card warn-card">
    <h3>General / misplaced <span class="count">${files.length}</span></h3>
    <p class="muted small">These files are not inside an indicator folder, so accreditors <strong>cannot see them</strong>. Move them into the right indicator folder in Drive.</p>
    <ul class="plain">${files.map((f) => `<li><a href="${esc(f.viewUrl)}" target="_blank" rel="noopener">${esc(f.name)}</a></li>`).join('')}</ul>
  </section>`;
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

// ── Step 1: choose a program ────────────────────────────────
export function renderHome(state) {
  const staff = isStaff();
  const visible = CONFIG.programs.filter((p) => !state.status[p.code]?.noAccess);
  const cards = visible.map((prog) => {
    const snap = state.snaps[prog.code];
    if (!snap) return `<li>${unavailable(prog, state.status[prog.code])}</li>`;
    return `<li><a class="card program-card" href="${href([prog.code])}">
        <h3>${esc(programName(prog, snap))}</h3>
        <p class="muted">${plural(snap.areas.length, 'area')} · ${plural(countFiles(snap), 'document')}</p>
        ${staff ? progressBadge(progress(snap)) : ''}
        <span class="cta">Choose →</span>
      </a></li>`;
  }).join('');

  const last = lastPlace.get();
  const lastSnap = last && state.snaps[last.prog];
  const lastArea = lastSnap && findArea(lastSnap, last.area);
  const resume = lastArea ? `<a class="resume" href="${hrefFor(last.prog, lastArea)}">
      <span>Continue where you left off:</span>
      <strong>${esc(programName(getProgram(last.prog), lastSnap))} › ${esc(areaLabel(lastArea))}</strong> →</a>` : '';

  return `${resume}${pageHead('<span class="step">Step 1 of 2</span>', 'Choose a program')}
    ${visible.length ? `<ul class="program-grid">${cards}</ul>`
      : `<div class="card empty"><p>No program is open for viewing yet. Please ask the accreditation coordinator.</p></div>`}
    <p class="muted small">Tip: use the search box above to find any document by name, keyword, or indicator.</p>`;
}

// ── Step 2: choose an area ──────────────────────────────────
export function renderProgram(state, route) {
  const prog = getProgram(route.prog);
  if (!prog) return notFound();
  const snap = state.snaps[prog.code];
  if (!snap) return unavailable(prog, state.status[prog.code]);
  const staff = isStaff();
  const cards = snap.areas.map((area) => `<li><a class="card area-card" href="${hrefFor(prog.code, area)}">
      <span class="badge badge-area">${esc(area.code)}</span>
      <span class="area-card-main">
        <span class="area-card-label">${esc(areaLabel(area))}</span>
        <span class="area-card-name">${esc(area.name)}</span>
        <span class="muted small">${docCountLabel(countFiles(area))}</span>
        ${staff ? progressBadge(progress(area), true) : ''}
      </span></a></li>`).join('');
  return crumbs([{ label: 'Programs', href: '#/' }, { label: programName(prog, snap), href: href([prog.code]) }]) +
    pageHead('<span class="step">Step 2 of 2</span>', 'Choose an area', `<p class="muted">${esc(programName(prog, snap))}</p>`) +
    looseSection(snap.looseFiles) +
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
          <span class="badge badge-area">${esc(area.code)}</span>
          <span class="tree-area-name">${esc(area.name)}</span>
        </a>
        <div class="tree-tools">
          <input type="search" class="tree-filter" id="treeFilter" placeholder="Filter this area…"
                 aria-label="Filter documents in this area" value="${esc(state.treeFilter)}" autocomplete="off">
          <button type="button" class="icon-btn" data-action="tree-expand" title="Expand all" aria-label="Expand all">⊞</button>
          <button type="button" class="icon-btn" data-action="tree-collapse" title="Collapse all" aria-label="Collapse all">⊟</button>
        </div>
        ${treeStaffTools(prog, snap, area, route)}
      </div>
      <div class="tree-scroll" id="treeScroll">
        <nav class="tree" id="tree">${renderTree(state, prog, area, route)}</nav>
        <div class="tree-results" id="treeResults" hidden></div>
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
    const pk = nodeKey(prog.code, area.code, param.code);
    const onP = route.param === param.code;
    const inds = param.indicators.map((ind) => {
      const ik = nodeKey(prog.code, area.code, param.code, ind.code);
      const onI = onP && route.ind === ind.code;
      const files = ind.files.map((f) => {
        const active = onI && route.fileId === f.id;
        const kind = fileKind(f.mimeType);
        return `<li><a class="tn-link tn-file ${active ? 'active' : ''}" href="${hrefFor(prog.code, area, param, ind, f.id)}"
            title="${esc(f.name)}" ${active ? 'aria-current="page"' : ''}>
          <span class="kind kind-xs ${kind.cls}">${kind.label}</span><span class="tn-text">${esc(f.name)}</span></a></li>`;
      }).join('');
      const indActive = onI && !route.fileId;
      const n = ind.files.length;
      return `<li class="tn-ind ${n ? '' : 'empty'}">
        <details data-node="${esc(ik)}" ${isOpen(ik, onI) ? 'open' : ''}>
          <summary><a class="tn-link ${indActive ? 'active' : ''}" href="${hrefFor(prog.code, area, param, ind)}"
              title="${esc(ind.code + ' · ' + (ind.text || ''))}" ${indActive ? 'aria-current="page"' : ''}>
            <span class="tn-code tn-${esc(ind.type || 'x')}">${esc(ind.code)}</span>
            <span class="tn-text">${esc(ind.text || ind.code)}</span>
            ${staff && !n ? '<span class="tn-missing" title="No documents yet">●</span>' : `<span class="tn-count">${n}</span>`}
          </a></summary>
          ${files ? `<ul>${files}</ul>` : '<p class="tn-none">No documents yet</p>'}
        </details></li>`;
    }).join('');
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
  return params ? `<ul class="tree-root">${params}</ul>` : '<p class="tn-none">No parameters found.</p>';
}

/** Flat list shown in the tree pane while the filter box has text. */
export function treeFilterResults(progCode, area, tokens) {
  if (!area) return '';
  const files = [];
  const inds = [];
  for (const param of area.parameters) {
    for (const ind of param.indicators) {
      const indText = normalize(`${ind.code} ${ind.text} ${param.code} ${param.name}`);
      if (tokens.every((t) => indText.includes(t))) inds.push({ param, ind });
      for (const f of ind.files) {
        const hay = normalize(`${f.name} ${(f.keywords || []).join(' ')} ${f.subfolder || ''}`) + ' ' + indText;
        if (tokens.every((t) => hay.includes(t))) files.push({ param, ind, f });
      }
    }
  }
  if (!files.length && !inds.length) return '<p class="tn-none">Nothing matches in this area.</p>';
  const fileItems = files.slice(0, 200).map(({ param, ind, f }) => {
    const kind = fileKind(f.mimeType);
    return `<li><a class="tn-link tn-file" href="${hrefFor(progCode, area, param, ind, f.id)}" title="${esc(f.name)}">
      <span class="kind kind-xs ${kind.cls}">${kind.label}</span>
      <span class="tn-text">${highlight(f.name, tokens)}<small class="tn-path">${esc(param.code)} › ${esc(ind.code)}</small></span></a></li>`;
  }).join('');
  const indItems = inds.slice(0, 50).map(({ param, ind }) => `<li><a class="tn-link" href="${hrefFor(progCode, area, param, ind)}">
      <span class="tn-code tn-${esc(ind.type || 'x')}">${esc(ind.code)}</span>
      <span class="tn-text">${highlight(ind.text || ind.code, tokens)}<small class="tn-path">${esc(paramLabel(param))}</small></span></a></li>`).join('');
  return `<p class="tn-summary">${plural(files.length, 'document')}${inds.length ? ', ' + plural(inds.length, 'indicator') : ''}</p>
    <ul class="tree-flat">${fileItems}${indItems}</ul>`;
}

/** The viewer pane stays empty until a document is picked; selecting a folder only opens it in the tree. */
function renderContent(state, prog, snap, area, route) {
  if (route.fileId) return renderViewer(state, prog, snap, area, route);
  return `<p class="viewer-empty">Select a document to view it</p>`;
}

/** Coordinator/admin tools above the tree (they used to live on the folder pages). */
function treeStaffTools(prog, snap, area, route) {
  if (!isStaff()) return '';
  const param = route.param ? findParam(area, route.param) : null;
  const ind = param && route.ind ? findIndicator(param, route.ind) : null;
  const target = ind || param || area;
  const label = ind ? ind.code : param ? paramLabel(param) : areaLabel(area);
  const add = target.folderId
    ? `<a class="btn btn-sm" href="https://drive.google.com/drive/folders/${esc(target.folderId)}" target="_blank" rel="noopener"
         title="Opens the ${esc(label)} folder in Google Drive. Drag your files into it.">＋ Add files to ${esc(label)} ↗</a>` : '';
  return `<div class="tree-staff">
    <div class="btn-row">${add}
      <button type="button" class="btn btn-sm" data-action="check-now" data-prog="${esc(prog.code)}"
        title="Rescan Google Drive now, right after uploading">↻ Check now</button>
    </div>
    <span class="muted small">Last checked ${esc(fmtDate(snap.generatedAt, true))}</span>
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
      <span class="viewer-path" title="${esc(ind.text || '')}">${esc(paramLabel(param))} › ${esc(ind.code)}</span>
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
      const pathText = `${multi ? progName + ' › ' : ''}${paramLabel(e.param)} › ${e.ind.code}`;
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
      <h3 class="group-title">${multi ? esc(progName) + ' · ' : ''}${esc(areaLabel(g.area))} — ${esc(g.area.name)}</h3>
      <ul class="results">${files}${inds}</ul>
    </section>`;
  }).join('');
  return `<div class="search-summary">${plural(results.total, 'result')} for “${esc(q)}”${where}
      <button type="button" class="btn btn-ghost btn-sm" data-action="clear-search">× Clear</button></div>
    ${groups}
    ${results.more ? `<p class="center"><button type="button" class="btn" data-action="show-more">Show more results</button></p>` : ''}`;
}
