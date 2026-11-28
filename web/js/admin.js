// Admin panel: accreditor access per program, watermark, scan status, issues.
import { CONFIG } from './config.js';
import { esc, fmtDate, toast } from './util.js';
import { href, parseHash } from './router.js';
import { post, isAdmin, accreditorList, NAMES_TTL_MS } from './api.js';
import { crumbs, progressBadge, notFound, programName } from './views.js';
import { getProgram, progress, areaLabel, areaKey, hrefFor, countFiles, realAreas, accessItems } from './model.js';

// ── Per-accreditor access ──
let accNames = null; // accreditor names from the main program's Access tab (null until loaded)
let accNamesAt = 0;  // when they were loaded
let who = '';        // accreditor the access card is editing ('' = the program default for everyone)

// The admin page redraws often (picking a name, saving, background updates). Issues and names
// are kept for a short while instead of asking the server again on every redraw.
const KEEP_MS = 60000;
const issuesCache = new Map(); // programCode → { at, res }

/** Forget everything loaded for the admin page (logout / new login). */
export function resetAdminCache() {
  accNames = null;
  accNamesAt = 0;
  who = '';
  issuesCache.clear();
}

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const findOverride = (settings, name) => (settings?.overrides || []).find((o) => sameName(o.name, name)) || null;

/** <option>s for the "Settings for" menu: everyone, every accreditor in the Access list, and any other name with its own settings. */
function whoOptions(state, prog) {
  const settings = state.settings[prog.code];
  const names = [];
  const add = (n) => { if (n && !names.some((x) => sameName(x, n))) names.push(n); };
  (accNames || []).forEach(add);
  (settings?.overrides || []).forEach((o) => add(o.name));
  add(who);
  const opt = (value, label) => `<option value="${esc(value)}" ${sameName(value, who) ? 'selected' : ''}>${esc(label)}</option>`;
  return opt('', 'Everyone (program default)') + names.map((n) => opt(n, n
    + (findOverride(settings, n) ? ' · own settings' : '')
    + (accNames && !accNames.some((x) => sameName(x, n)) ? ' · not in the Access list' : ''))).join('');
}

/** Names that have their own settings but no PIN row in the Access tab (renamed or mistyped). */
function unmatchedHtml(state) {
  if (accNames === null) return '';
  const bad = [];
  for (const p of CONFIG.programs) {
    for (const o of state.settings[p.code]?.overrides || []) {
      if (!accNames.some((x) => sameName(x, o.name))) bad.push(`${o.name} (${p.name})`);
    }
  }
  return bad.length ? `<p class="error small">These names have their own access settings but are not in the Access list, so no PIN uses them: ${esc(bad.join(', '))}.
    Pick the name above and press "Use the program default again" to remove it, or fix the spelling in the Access tab.</p>` : '';
}

/** Choose who the access card edits. Called when the menu changes or a name is picked from the list. */
export function setAccreditor(name, app) {
  who = String(name || '');
  app.state.touched = false;
  app.render();
}

export function renderAdmin(state, route) {
  if (!isAdmin()) return notFound('#/', 'The admin panel needs the admin PIN.');
  const prog = getProgram(route.prog) || CONFIG.programs[0];
  const snap = state.snaps[prog.code];
  const settings = state.settings[prog.code];
  const tabs = CONFIG.programs.map((p) => `<a class="chip ${p.code === prog.code ? 'active' : ''}" href="${href(['admin', p.code])}"
      ${p.code === prog.code ? 'aria-current="true"' : ''}>${esc(programName(p, state.snaps[p.code]))}</a>`).join('');

  // ── Accreditor access for this program ──
  const st = state.status[prog.code] || {};
  const spinner = `<div class="loading-block"><span class="spinner"></span> Loading…</div>`;
  // Saved area codes and snapshot codes can differ in form ("2" vs "II"), so compare keys.
  const openKeys = settings && settings.accreditorAreas !== 'ALL' ? new Set((settings.accreditorAreas || []).map(areaKey)) : null;
  let access;
  if (!snap) {
    access = st.noAccess
      ? `<p class="error">This program's server did not accept the admin session.</p>
        <p class="muted small">Check that it is linked to the main program (Link to main program in its Sheet), then reload this page.</p>`
      : st.error && !st.loading
        ? `<p class="error">${esc(st.error)}</p>${st.code === 'notLinked' ? '' : `
          <p class="muted small">Press Refresh now (or Rebuild structure) below to build this program's snapshot.</p>`}`
        : spinner;
  } else if (!settings) {
    access = st.loading || st.fromCache ? spinner
      : `<p class="muted">Access settings are not available for this program right now. Press Refresh now below to load them.</p>`;
  } else {
    // Settings shown in the form: the program default, or the chosen accreditor's own (when they have any).
    const ov = who ? findOverride(settings, who) : null;
    const view = ov ? { enabled: ov.enabled, areas: ov.areas } : { enabled: settings.accreditorEnabled, areas: settings.accreditorAreas };
    const all = view.areas === 'ALL';
    const chosen = all ? new Set(accessItems(snap).map((a) => areaKey(a.code))) : new Set((view.areas || []).map(areaKey));
    const subject = who ? esc(who) : 'Accreditors';
    const overrides = settings.overrides || [];
    access = `
      <div class="access-who">
        <label for="adm-who"><strong>Settings for</strong></label>
        <select id="adm-who" data-admin-who data-prog="${esc(prog.code)}">${whoOptions(state, prog)}</select>
        ${accNames === null ? '<span class="muted small">Loading accreditor names…</span>' : ''}
      </div>
      <p class="muted small">${!who
        ? 'These settings apply to every accreditor who has no settings of their own in this program.'
        : ov ? `${esc(who)} has their own settings in this program. They replace the default for ${esc(who)} only.`
          : `${esc(who)} follows the program default for now. Saving creates settings just for ${esc(who)}.`}</p>
      <div id="adm-unmatched">${unmatchedHtml(state)}</div>
      <form data-form="access" data-prog="${esc(prog.code)}" data-who="${esc(who)}" class="access-form">
      <label class="switch"><input type="checkbox" name="enabled" ${view.enabled ? 'checked' : ''}>
        <span>${subject} can open <strong>${esc(programName(prog, snap))}</strong></span></label>
      <fieldset class="area-checks">
        <legend>What ${subject} can see</legend>
        <div class="btn-row tight">
          <button type="button" class="btn btn-ghost btn-sm" data-action="areas-all">Select all</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="areas-none">Select none</button>
        </div>
        <div class="check-grid">${accessItems(snap).map((a) => `<label class="check">
            <input type="checkbox" name="area" value="${esc(a.code)}" ${chosen.has(areaKey(a.code)) ? 'checked' : ''}>
            <span><strong>${esc(a.label)}</strong>${a.name ? ' ' + esc(a.name) : ''} <span class="muted small">· ${a.docs} docs</span></span></label>`).join('')}</div>
        <p class="muted small">When every area is ticked, new areas added later are shown automatically.
          Other files at the top of the program folder ("Other documents") are shown whenever the program is open.</p>
      </fieldset>
      <div class="btn-row">
        <button type="submit" class="btn btn-primary">Save access</button>
        ${ov ? `<button type="button" class="btn" data-action="acc-reset" data-prog="${esc(prog.code)}">Use the program default again</button>` : ''}
        <span class="form-status" aria-live="polite"></span>
      </div>
    </form>
    ${!who && overrides.length ? `<div class="access-own">
      <h4>Accreditors with their own settings here</h4>
      <ul class="issue-list">${overrides.map((o) => `<li><button type="button" class="btn btn-ghost btn-sm" data-action="acc-pick" data-who="${esc(o.name)}">${esc(o.name)}</button>
        ${!o.enabled ? '<span class="muted">cannot open this program</span>'
          : o.areas === 'ALL' ? '<span class="ok">every area</span>'
          : `<span>${o.areas.length ? o.areas.map((c) => esc(areaLabel({ code: c }))).join(', ') : 'no areas'}</span>`}</li>`).join('')}</ul>
    </div>` : ''}`;
  }

  const areaRows = snap ? realAreas(snap).map((a) => `<tr><td><a href="${hrefFor(prog.code, a)}">${esc(areaLabel(a))}</a></td><td>${esc(a.name)}</td>
      <td>${progressBadge(progress(a), true)}</td><td class="num">${countFiles(a)}</td>
      <td>${settings && (settings.accreditorAreas === 'ALL' || openKeys.has(areaKey(a.code))) && settings.accreditorEnabled
        ? '<span class="ok">Open</span>' : '<span class="muted">Hidden</span>'}</td></tr>`).join('') : '';
  const total = snap ? progress(snap) : null;

  return crumbs([{ label: 'Programs', href: '#/' }, { label: 'Admin', href: href(['admin', prog.code]) }]) + `
    <header class="page-head"><div class="eyebrow">Admin</div>
      <h2 class="page-title">Admin panel</h2></header>

    <section class="card">
      <h3>Accreditor screens (all programs)</h3>
      <form data-form="watermark">
        <label class="switch"><input type="checkbox" name="watermark" ${state.watermark ? 'checked' : ''}>
          <span>Show a watermark over documents (the accreditor's initials and today's date)</span></label>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary btn-sm">Save</button>
          <span class="form-status" aria-live="polite"></span>
        </div>
      </form>
    </section>

    <nav class="chips admin-tabs" aria-label="Program">${tabs}</nav>

    <section class="card">
      <h3>Accreditor access · ${esc(programName(prog, snap))}</h3>
      ${access}
    </section>

    <section class="card admin-status">
      <h3>Scan status</h3>
      <div class="stat-grid">
        <div><span class="stat-label">Last scan</span><span class="stat-value" id="adm-lastscan">${snap ? esc(fmtDate(snap.generatedAt, true)) : '—'}</span></div>
        <div><span class="stat-label">Scan time</span><span class="stat-value" id="adm-scanms">…</span></div>
        <div><span class="stat-label">Auto-refresh trigger</span><span class="stat-value" id="adm-trigger">…</span></div>
        <div><span class="stat-label">Indicators with documents</span><span class="stat-value">${total ? `${total.done}/${total.total} (${total.pct}%)` : '—'}</span></div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-action="admin-refresh" data-prog="${esc(prog.code)}">Refresh now</button>
        <button type="button" class="btn" data-action="admin-rebuild" data-prog="${esc(prog.code)}">Rebuild structure</button>
        <span class="form-status" id="adm-status" aria-live="polite"></span>
      </div>
      <p class="muted small">Refresh now rescans the files (normally automatic every 5 minutes). Rebuild structure re-reads the folder tree: use it after adding, removing, or renaming folders. Avoid it during the visit itself.</p>
    </section>

    <section class="card">
      <h3>Progress by area</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Area</th><th>Name</th><th>Indicators</th><th class="num">Docs</th><th>Everyone (default)</th></tr></thead>
        <tbody>${areaRows}</tbody></table></div>
    </section>

    <section class="card">
      <h3>Issues</h3>
      <div id="adm-issues" data-prog="${esc(prog.code)}"><div class="loading-block"><span class="spinner"></span> Loading issues…</div></div>
    </section>`;
}

const ISSUE_LABELS = {
  badFolderName: ['Folder names not following the pattern', 'Still shown on the site. Fix the name in Drive, or set codeOverride / nameOverride in the Structure tab, then Rebuild structure.'],
  duplicateCode: ['Duplicate codes', 'Two folders with the same code under one parent.'],
  missingFolder: ['Missing folders', 'Folder is in the trash or deleted. Restore it from Drive Trash, or Rebuild structure if it was removed on purpose.'],
  movedFolder: ['Moved folders', 'Folder was moved somewhere else. Its files are still listed, but move it back to keep Drive tidy.'],
  newFolder: ['New folders not in the structure', 'Run “Rebuild structure” so they appear on the site.'],
  deepFile: ['Folders nested too deep', 'Only 6 levels of subfolders inside an indicator are scanned. Move these files up a few levels.'],
};

/** Fetch issues + status after the admin page is in the DOM (`force`: after Refresh now / Rebuild). */
export async function loadAdminData(progCode, state, force = false) {
  const prog = getProgram(progCode) || CONFIG.programs[0];
  const box = document.getElementById('adm-issues');
  if (!isAdmin() || !box) return;
  if (state) loadAccreditorNames(prog, state);
  const hit = issuesCache.get(prog.code);
  let res;
  if (!force && hit && Date.now() - hit.at < KEEP_MS) {
    res = hit.res;
  } else {
    res = await post(prog, { action: 'issues' });
    if (res.ok) issuesCache.set(prog.code, { at: Date.now(), res });
  }
  // Drop a late answer after leaving the page or switching to another program's tab.
  const cur = parseHash();
  const curCode = (getProgram(cur.prog) || CONFIG.programs[0]).code;
  if (cur.name !== 'admin' || curCode !== prog.code || !box.isConnected || box.dataset.prog !== prog.code) return;
  if (!res.ok) {
    box.innerHTML = `<p class="error">${esc(res.message || 'Could not load issues.')}</p>`;
    return;
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  if (res.lastScan) set('adm-lastscan', fmtDate(res.lastScan, true));
  set('adm-scanms', res.lastScanMs ? (res.lastScanMs / 1000).toFixed(1) + ' s' : '—');
  set('adm-trigger', res.triggerActive ? 'On (every 5 min)' : 'OFF: install it from the Sheet menu');
  const byType = {};
  // Files outside indicator folders are shown as "General documents" now; an issues.json
  // written by an older backend can still list them as "misplaced".
  for (const it of res.items || []) if (it.type !== 'misplaced') (byType[it.type] = byType[it.type] || []).push(it);
  const types = Object.keys(byType);
  if (!types.length) { box.innerHTML = '<p class="ok">✓ No issues found.</p>'; return; }
  box.innerHTML = types.map((t) => {
    const [label, hint] = ISSUE_LABELS[t] || [t, ''];
    return `<details class="issue-group" open><summary><strong>${esc(label)}</strong> <span class="count">${byType[t].length}</span></summary>
      <p class="muted small">${esc(hint)}</p>
      <ul class="issue-list">${byType[t].map((it) => {
        const url = it.url || (it.fileId ? `https://drive.google.com/file/d/${it.fileId}/view`
          : it.folderId ? `https://drive.google.com/drive/folders/${it.folderId}` : '');
        return `<li><span class="issue-path">${esc(it.path || '')}</span>
          ${it.name ? `<span class="issue-name">${esc(it.name)}</span>` : ''}
          ${it.reason ? `<span class="muted">(${esc(it.reason)})</span>` : ''}
          ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open in Drive ↗</a>` : ''}</li>`;
      }).join('')}</ul></details>`;
  }).join('');
}

/** Ask the main program for the accreditor names, then fill the "Settings for" menu in place (no redraw, so nothing typed is lost). */
async function loadAccreditorNames(prog, state) {
  // Already loaded: renderAdmin used them, nothing to fill in.
  if (accNames !== null && Date.now() - accNamesAt < NAMES_TTL_MS) return;
  // The same kept list as the Requested Documents pages (one request per 2 minutes at most).
  let list;
  try { list = await accreditorList(); } catch { return; }
  if (!isAdmin()) return; // logged out meanwhile
  accNames = list.names;
  accNamesAt = list.at;
  const sel = document.getElementById('adm-who');
  if (!sel || !sel.isConnected || sel.dataset.prog !== prog.code) return;
  sel.innerHTML = whoOptions(state, prog);
  sel.parentElement?.querySelector('.muted.small')?.remove();
  const um = document.getElementById('adm-unmatched');
  if (um) um.innerHTML = unmatchedHtml(state);
}

export async function adminAction(kind, progCode, button, app) {
  const prog = getProgram(progCode);
  const status = document.getElementById('adm-status');
  if (!isAdmin() || !prog) return;
  if (kind === 'rebuild' && button.dataset.confirm !== '1') {
    button.dataset.confirm = '1';
    button.textContent = 'Tap again to confirm rebuild';
    button.classList.add('btn-danger');
    setTimeout(() => {
      button.dataset.confirm = '';
      button.textContent = 'Rebuild structure';
      button.classList.remove('btn-danger');
    }, 5000);
    return;
  }
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = kind === 'rebuild' ? 'Rebuilding structure… (up to a minute)' : 'Scanning files…';
  // These can run for minutes on big programs (Apps Script allows 6), longer than the normal timeout.
  const res = await post(prog, { action: kind === 'rebuild' ? 'rebuildStructure' : 'refresh' }, { timeoutMs: 360000 });
  button.disabled = false;
  if (!res.ok) {
    status.className = 'form-status error';
    status.textContent = res.error === 'busy' ? 'A scan is already running. Try again in a minute.' : res.message || 'Failed.';
    return;
  }
  status.className = 'form-status ok';
  status.textContent = '✓ Done. Reloading data…';
  toast(`✓ ${kind === 'rebuild' ? 'Structure rebuilt' : 'Snapshot refreshed'}${res.ms ? ' in ' + (res.ms / 1000).toFixed(1) + ' s' : ''}.`);
  // The reply carries the issues list (an older backend doesn't: then ask for it).
  const hasIssues = Array.isArray(res.items);
  if (hasIssues) issuesCache.set(prog.code, { at: Date.now(), res });
  await app.refresh(progCode, true);
  loadAdminData(progCode, app.state, !hasIssues);
}

/** Watermark is one setting for every program: saved to each program's backend. */
export async function saveWatermark(form, app) {
  const status = form.querySelector('.form-status');
  const button = form.querySelector('button[type=submit]');
  const watermark = form.querySelector('input[name=watermark]').checked;
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = 'Saving…';
  const results = await Promise.all(CONFIG.programs.map((p) => post(p, { action: 'saveSettings', watermark })
    .then((res) => ({ p, res }))));
  button.disabled = false;
  const failed = results.filter((r) => !r.res.ok);
  for (const { p, res } of results) if (res.ok) app.state.settings[p.code] = { ...app.state.settings[p.code], ...res.settings };
  app.state.touched = false;
  if (failed.length) {
    status.className = 'form-status error';
    status.textContent = 'Not saved for: ' + failed.map((r) => `${r.p.name} (${r.res.message || r.res.error})`).join(', ');
    return;
  }
  status.className = 'form-status ok';
  status.textContent = `✓ Watermark ${watermark ? 'on' : 'off'}.`;
  toast(`✓ Watermark ${watermark ? 'on' : 'off'} for accreditors.`);
}

export async function saveAccess(form, app) {
  const prog = getProgram(form.dataset.prog);
  const snap = app.state.snaps[prog?.code];
  const status = form.querySelector('.form-status');
  const button = form.querySelector('button[type=submit]');
  if (!prog || !snap) return;
  const enabled = form.querySelector('input[name=enabled]').checked;
  const picked = [...form.querySelectorAll('input[name=area]:checked')].map((i) => i.value);
  const pickedKeys = new Set(picked.map(areaKey));
  const areas = accessItems(snap).every((a) => pickedKeys.has(areaKey(a.code))) ? 'ALL' : picked;
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = 'Saving…';
  const target = form.dataset.who || '';
  const subject = target || 'Accreditors';
  const res = await post(prog, { action: 'saveSettings', accreditorEnabled: enabled, accreditorAreas: areas, ...(target ? { accreditor: target } : {}) });
  button.disabled = false;
  if (!res.ok) {
    status.className = 'form-status error';
    status.textContent = res.message || 'Could not save.';
    return;
  }
  app.state.settings[prog.code] = { ...app.state.settings[prog.code], ...res.settings };
  app.state.touched = false;
  toast(`✓ ${target ? target + "'s access" : 'Accreditor access'} saved for ${prog.name}.`);
  app.render();
  const box = document.querySelector('form[data-form="access"] .form-status');
  if (box) {
    box.className = 'form-status ok';
    box.textContent = !enabled ? `✓ Saved. ${subject} cannot open this program.`
      : areas === 'ALL' ? `✓ Saved. ${subject} see${target ? 's' : ''} every area.`
      : `✓ Saved. ${subject} see${target ? 's' : ''} ${picked.length ? picked.map((c) => areaLabel({ code: c })).join(', ') : 'no areas'}.`;
  }
}

/** Remove one accreditor's own settings in a program: they follow the program default again. */
export async function resetAccreditor(progCode, app) {
  const prog = getProgram(progCode);
  const target = who;
  if (!prog || !target) return;
  const status = document.querySelector('form[data-form="access"] .form-status');
  if (status) { status.className = 'form-status'; status.textContent = 'Saving…'; }
  const res = await post(prog, { action: 'saveSettings', accreditor: target, reset: true });
  if (!res.ok) {
    if (status) { status.className = 'form-status error'; status.textContent = res.message || 'Could not save.'; }
    return;
  }
  app.state.settings[prog.code] = { ...app.state.settings[prog.code], ...res.settings };
  app.state.touched = false;
  toast(`✓ ${target} follows the ${prog.name} default again.`);
  app.render();
}
