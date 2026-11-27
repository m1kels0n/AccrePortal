// Hash routing:
//   #/login                     PIN login
//   #/                          step 1: choose a program
//   #/p1                        step 2: choose an area
//   #/p1/II                     workspace: file tree (left) + area overview (right)
//   #/p1/II/A                   workspace + parameter
//   #/p1/II/A/S.1               workspace + indicator (its documents)
//   #/p1/II/A/S.1/f/<fileId>    workspace + document viewer
//   #/admin[/p1]                admin panel
//   #/files                     all files of every program in one list (coordinators and admin)
//   #/files/p1/II/A/S.1/<id>    that list + the document beside it
//   …any route…?q=words         search results

export function parseHash(hash = location.hash) {
  let h = String(hash || '').replace(/^#/, '');
  if (!h.startsWith('/')) h = '/' + h;
  const qIndex = h.indexOf('?');
  const path = qIndex === -1 ? h : h.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? '' : h.slice(qIndex + 1));
  const segs = path.split('/').filter(Boolean).map(safeDecode);
  const route = { name: 'home', segs, q: params.get('q') || '', prog: null, area: null, param: null, ind: null, fileId: null };

  if (segs[0] === 'login') { route.name = 'login'; return route; }
  if (segs[0] === 'admin') {
    route.name = 'admin';
    route.prog = segs[1] || null;
    return route;
  }
  if (segs[0] === 'files') {
    route.name = 'files';
    if (segs.length === 6 && segs[5]) [route.prog, route.area, route.param, route.ind, route.fileId] = segs.slice(1);
    return route;
  }
  [route.prog, route.area, route.param, route.ind] = [segs[0] || null, segs[1] || null, segs[2] || null, segs[3] || null];
  if (segs.length === 0) route.name = 'home';
  else if (segs.length === 1) route.name = 'program';
  else if (segs.length <= 4) route.name = 'workspace';
  else if (segs.length === 6 && segs[4] === 'f' && segs[5]) { route.fileId = segs[5]; route.name = 'workspace'; }
  else route.name = 'notfound';
  return route;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Build a hash from path parts (null/undefined parts are dropped). */
export function href(parts, q = '') {
  const path = parts.filter((p) => p !== null && p !== undefined && p !== '')
    .map((p) => encodeURIComponent(p)).join('/');
  return '#/' + path + (q ? '?q=' + encodeURIComponent(q) : '');
}

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

/** Update only the ?q= part without adding a history entry. */
export function replaceQuery(q) {
  const r = parseHash();
  const next = href(r.segs, q.trim());
  history.replaceState(null, '', next);
}
