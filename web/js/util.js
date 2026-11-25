import { CONFIG } from './config.js';

/** Escape text for safe insertion into HTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DIACRITICS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g'); // combining accents

/** Lower-case and strip accents ("Pañgasinan" → "pangasinan"). */
export function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(DIACRITICS, '').toLowerCase();
}

/** Split a query into normalized search tokens. */
export function tokenize(query) {
  return normalize(query).split(/[\s,;]+/).filter(Boolean);
}

/**
 * Wrap every occurrence of the tokens in <mark>, matching accent- and
 * case-insensitively while keeping the original characters.
 */
export function highlight(text, tokens) {
  const original = String(text ?? '');
  if (!tokens || !tokens.length) return esc(original);
  // Build the normalized string with a map back to original indexes.
  let norm = '';
  const start = [];
  const end = [];
  let i = 0;
  for (const ch of original) {
    const n = normalize(ch);
    for (let k = 0; k < n.length; k++) { start.push(i); end.push(i + ch.length); }
    norm += n;
    i += ch.length;
  }
  const ranges = [];
  for (const t of tokens) {
    let from = 0;
    while (t && (from = norm.indexOf(t, from)) !== -1) {
      ranges.push([start[from], end[from + t.length - 1]]);
      from += t.length;
    }
  }
  if (!ranges.length) return esc(original);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r);
  }
  let out = '';
  let pos = 0;
  for (const [a, b] of merged) {
    out += esc(original.slice(pos, a)) + '<mark>' + esc(original.slice(a, b)) + '</mark>';
    pos = b;
  }
  return out + esc(original.slice(pos));
}

/** Short type label + css class for a mime type. */
export function fileKind(mime) {
  const m = String(mime || '');
  if (m === 'application/pdf') return { label: 'PDF', cls: 'k-pdf' };
  if (m === 'application/vnd.google-apps.document' || /wordprocessingml|msword|opendocument\.text|rtf/.test(m)) return { label: 'DOC', cls: 'k-doc' };
  if (m === 'application/vnd.google-apps.spreadsheet' || /spreadsheetml|ms-excel|csv|opendocument\.spreadsheet/.test(m)) return { label: 'XLS', cls: 'k-xls' };
  if (m === 'application/vnd.google-apps.presentation' || /presentationml|ms-powerpoint|opendocument\.presentation/.test(m)) return { label: 'PPT', cls: 'k-ppt' };
  if (m === 'application/vnd.google-apps.form') return { label: 'FORM', cls: 'k-form' };
  if (m === 'application/vnd.google-apps.folder') return { label: 'FOLDER', cls: 'k-folder' };
  if (m.startsWith('image/')) return { label: 'IMG', cls: 'k-img' };
  if (m.startsWith('video/')) return { label: 'VID', cls: 'k-vid' };
  if (m.startsWith('audio/')) return { label: 'AUD', cls: 'k-vid' };
  return { label: 'FILE', cls: 'k-file' };
}

export function fmtSize(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function fmtDate(iso, withTime = false) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const opts = { timeZone: CONFIG.timezone, month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  if (withTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
  try { return new Intl.DateTimeFormat('en-PH', opts).format(d); }
  catch { return d.toLocaleString(); }
}

export function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Safe localStorage / sessionStorage access (private mode can throw). */
export const store = {
  get(key, session = false) {
    try {
      const raw = (session ? sessionStorage : localStorage).getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  set(key, value, session = false) {
    try { (session ? sessionStorage : localStorage).setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key, session = false) {
    try { (session ? sessionStorage : localStorage).removeItem(key); } catch { /* ignore */ }
  },
};

let toastTimer;
export function toast(message, kind = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast toast-' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
