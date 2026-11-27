// ─────────────────────────────────────────────────────────────
//  Site configuration: the ONLY file you need to edit.
//  Never put PINs or other secrets here: this file is public.
// ─────────────────────────────────────────────────────────────
export const CONFIG = {
  school: 'Technological University of the Philippines',
  college: 'College of Industrial Education',
  title: 'MAIE-AS and MAT-THE Program Accreditation',

  logos: [
    { src: 'assets/tup-logo-128.png', alt: 'TUP logo' },
    { src: 'assets/cie-logo-128.png', alt: 'CIE logo' },
  ],

  colors: {
    primary: '#7a0019',   // TUP maroon
    secondary: '#1e4f9c', // blue: links, focus rings, selected filters, header gradient
    accent:  '#c9a227',   // gold
  },

  // 'mock' = use data/mock-*.json (no backend needed)
  // 'live' = use each program's `source` below
  // You can also force it from the address bar: ?mock=1 or ?mock=0
  mode: 'live',

  // Everyone logs in with a 6-digit PIN (accreditor, coordinator or admin).
  // false = no login screen; everyone is a view-only accreditor (only for Plan B, see README).
  requireLogin: true,

  // Transparent cover over the Google Drive preview's "Open in new window" button, for accreditors.
  // Sizes in pixels, measured from the top-right corner of the preview. Everything else in the
  // preview (scrolling, page number, zoom) stays usable.
  viewerShield: { top: 0, right: 0, width: 80, height: 64 },

  timezone: 'Asia/Manila',
  refreshMinutes: 5,        // background refresh while the page is open
  requestTimeoutMs: 25000,

  // The FIRST program is the MAIN one: its Google Sheet holds every PIN and handles all logins.
  programs: [
    {
      code: 'p1',
      name: 'MAIE-AS',
      // 'api'    = Apps Script web app (normal)
      // 'static' = Plan B: a snapshot JSON file committed to this site
      source: 'api',
      apiUrl: 'https://script.google.com/macros/s/AKfycbzwYwB5XIvWbLuK-uhYYjSo7mnqnQ8i8EJVBI5oy04whUIH1PPfhnOOV9Fh9CIFAXANfA/exec',
      staticUrl: 'data/snapshot-p1.json',
      mockUrl: 'data/mock-p1.json',
    },
    {
      code: 'p2',
      name: 'MAT-THE',
      source: 'api',
      apiUrl: 'https://script.google.com/macros/s/AKfycbwPNVTk51DbLGjhzdB5cwd-JzDmHuEXapJoTEj1tgfVUBOtUKRrWaQ9ZWA5L2NOuMZ_/exec',
      staticUrl: 'data/snapshot-p2.json',
      mockUrl: 'data/mock-p2.json',
    },
  ],
};
