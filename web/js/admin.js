// Admin panel: accreditor access per program, watermark, scan status, issues.
import { CONFIG } from './config.js';
import { esc, fmtDate, toast } from './util.js';
import { href } from './router.js';
import { post, isAdmin } from './api.js';
import { crumbs, progressBadge, notFound, programName } from './views.js';
import { getProgram, progress, areaLabel, hrefFor, countFiles } from './model.js';

export function renderAdmin(state, route) {
  if (!isAdmin()) return notFound('#/', 'The admin panel needs the admin PIN.');
  const prog = getProgram(route.prog) || CONFIG.programs[0];
  const snap = state.snaps[prog.code];
  const settings = state.settings[prog.code];
  const tabs = CONFIG.programs.map((p) => `<a class="chip ${p.code === prog.code ? 'active' : ''}" href="${href(['admin', p.code])}"
      ${p.code === prog.code ? 'aria-current="true"' : ''}>${esc(programName(p, state.snaps[p.code]))}</a>`).join('');

  // ── Accreditor access for this program ──
  let access;
  if (!snap || !settings) {
    access = `<div class="loading-block"><span class="spinner"></span> Loading…</div>`;
  } else {
    const all = settings.accreditorAreas === 'ALL';
    const chosen = new Set(all ? snap.areas.map((a) => a.code) : settings.accreditorAreas);
    access = `<form data-form="access" data-prog="${esc(prog.code)}" class="access-form">
      <label class="switch"><input type="checkbox" name="enabled" ${settings.accreditorEnabled ? 'checked' : ''}>
        <span>Accreditors can open <strong>${esc(programName(prog, snap))}</strong></span></label>
      <fieldset class="area-checks">
        <legend>Areas accreditors can see</legend>
        <div class="btn-row tight">
          <button type="button" class="btn btn-ghost btn-sm" data-action="areas-all">Select all</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="areas-none">Select none</button>
        </div>
        <div class="check-grid">${snap.areas.map((a) => `<label class="check">
            <input type="checkbox" name="area" value="${esc(a.code)}" ${chosen.has(a.code) ? 'checked' : ''}>
            <span><strong>${esc(areaLabel(a))}</strong> ${esc(a.name)} <span class="muted small">· ${countFiles(a)} docs</span></span></label>`).join('')}</div>
        <p class="muted small">When every area is ticked, new areas added later are shown automatically.</p>
      </fieldset>
      <div class="btn-row">
        <button type="submit" class="btn btn-primary">Save access</button>
        <span class="form-status" aria-live="polite"></span>
      </div>
    </form>`;
  }

  const areaRows = snap ? snap.areas.map((a) => `<tr><td><a href="${hrefFor(prog.code, a)}">${esc(areaLabel(a))}</a></td><td>${esc(a.name)}</td>
      <td>${progressBadge(progress(a), true)}</td><td class="num">${countFiles(a)}</td>
      <td>${settings && (settings.accreditorAreas === 'ALL' || settings.accreditorAreas.includes(a.code)) && settings.accreditorEnabled
        ? '<span class="ok">Open</span>' : '<span class="muted">Hidden</span>'}</td></tr>`).join('') : '';
  const total = snap ? progress(snap) : null;

  return crumbs([{ label: 'Programs', href: '#/' }, { label: 'Admin', href: href(['admin', prog.code]) }]) + `
    <header class="page-head"><div class="eyebrow">Admin</div>
      <h2 class="page-title">Admin panel</h2></header>

    <section class="card">
      <h3>Accreditor screens (all programs)</h3>
      <form data-form="watermark">
        <label class="switch"><input type="checkbox" name="watermark" ${state.watermark ? 'checked' : ''}>
          <span>Show a watermark over documents (the accreditor's name and today's date)</span></label>
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
        <thead><tr><th>Area</th><th>Name</th><th>Indicators</th><th class="num">Docs</th><th>Accreditors</th></tr></thead>
        <tbody>${areaRows}</tbody></table></div>
    </section>

    <section class="card">
      <h3>Issues</h3>
      <div id="adm-issues"><div class="loading-block"><span class="spinner"></span> Loading issues…</div></div>
    </section>`;
}

const ISSUE_LABELS = {
  misplaced: ['Misplaced files', 'Files sitting in an Area/Parameter folder (or the root) instead of an indicator folder. Move them into the right indicator.'],
  badFolderName: ['Folder names not following the pattern', 'Still shown on the site. Fix the name in Drive, or set codeOverride / nameOverride in the Structure tab, then Rebuild structure.'],
  duplicateCode: ['Duplicate codes', 'Two folders with the same code under one parent.'],
  missingFolder: ['Missing folders', 'Folder is in the trash or deleted. Restore it from Drive Trash, or Rebuild structure if it was removed on purpose.'],
  movedFolder: ['Moved folders', 'Folder was moved somewhere else. Its files are still listed, but move it back to keep Drive tidy.'],
  newFolder: ['New folders not in the structure', 'Run “Rebuild structure” so they appear on the site.'],
  deepFile: ['Folders nested too deep', 'Only one level of subfolders inside an indicator is scanned. Move these files up a level.'],
};

/** Fetch issues + status after the admin page is in the DOM. */
export async function loadAdminData(progCode) {
  const prog = getProgram(progCode) || CONFIG.programs[0];
  const box = document.getElementById('adm-issues');
  if (!isAdmin() || !box) return;
  const res = await post(prog, { action: 'issues' });
  if (!document.getElementById('adm-issues')) return; // navigated away
  if (!res.ok) {
    box.innerHTML = `<p class="error">${esc(res.message || 'Could not load issues.')}</p>`;
    return;
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  if (res.lastScan) set('adm-lastscan', fmtDate(res.lastScan, true));
  set('adm-scanms', res.lastScanMs ? (res.lastScanMs / 1000).toFixed(1) + ' s' : '—');
  set('adm-trigger', res.triggerActive ? 'On (every 5 min)' : 'OFF: install it from the Sheet menu');
  const byType = {};
  for (const it of res.items || []) (byType[it.type] = byType[it.type] || []).push(it);
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
  const res = await post(prog, { action: kind === 'rebuild' ? 'rebuildStructure' : 'refresh' });
  button.disabled = false;
  if (!res.ok) {
    status.className = 'form-status error';
    status.textContent = res.error === 'busy' ? 'A scan is already running. Try again in a minute.' : res.message || 'Failed.';
    return;
  }
  status.className = 'form-status ok';
  status.textContent = '✓ Done. Reloading data…';
  toast(`✓ ${kind === 'rebuild' ? 'Structure rebuilt' : 'Snapshot refreshed'}${res.ms ? ' in ' + (res.ms / 1000).toFixed(1) + ' s' : ''}.`);
  await app.refresh(progCode, true);
  loadAdminData(progCode);
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
  const areas = picked.length === snap.areas.length ? 'ALL' : picked;
  button.disabled = true;
  status.className = 'form-status';
  status.textContent = 'Saving…';
  const res = await post(prog, { action: 'saveSettings', accreditorEnabled: enabled, accreditorAreas: areas });
  button.disabled = false;
  if (!res.ok) {
    status.className = 'form-status error';
    status.textContent = res.message || 'Could not save.';
    return;
  }
  app.state.settings[prog.code] = { ...app.state.settings[prog.code], ...res.settings };
  app.state.touched = false;
  toast(`✓ Accreditor access saved for ${prog.name}.`);
  app.render();
  const box = document.querySelector('form[data-form="access"] .form-status');
  if (box) {
    box.className = 'form-status ok';
    box.textContent = !enabled ? '✓ Saved. Accreditors cannot open this program.'
      : areas === 'ALL' ? '✓ Saved. Accreditors see every area.'
      : `✓ Saved. Accreditors see ${picked.length ? picked.map((c) => 'Area ' + c).join(', ') : 'no areas'}.`;
  }
}
