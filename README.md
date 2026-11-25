# AACCUP Accreditation Evidence Portal (TUP CIE)

A small, free, short-term website where AACCUP accreditors can browse and search the evidence documents of **2 programs**. Google Drive is the single source of truth: coordinators upload into fixed folders, and the site updates by itself every 5 minutes.

```
Coordinators ──upload──▶ Google Drive (folder tree per program)
                              │ read by folder ID
                 Apps Script bound to a Google Sheet (1 per program)
                   ├─ Build structure (manual)   → Structure tab
                   ├─ Build snapshot (every 5 min) → snapshot.json + cache
                   └─ Web app: GET snapshot · POST login/keywords/admin
                              │
                 Static website on GitHub Pages (HTML/CSS/JS, no build step)
```

| Folder | What it is |
|---|---|
| `web/` | The website. Upload this folder's **contents** to GitHub Pages. Edit only `web/js/config.js`. |
| `apps-script/` | The backend code. Paste these files into the Apps Script editor of each program's Sheet. |
| `COORDINATOR_GUIDE.md` | One-page guide for area coordinators. Print it or share it. |

**Flow:** Log in with a 6-digit PIN → choose a program → choose an area → workspace: header on top, the area's file tree on the left (about 35%) and the overview on the right. Once a document is selected, the tree shrinks to about 15% on the left and widens to 35% while the mouse is over it (it overlays the document, so the document doesn't move). On phones and touch screens the tree folds into a **☰ Show files** bar that opens a slide-out list instead. **⌂ Home** returns to program selection and **▦ Areas** to area selection. The Program ▾ / Area ▾ menus switch directly. On phones, the tree is behind **☰ Files**.

**Roles.** The PIN alone decides the role:

| Role | PIN | Can do |
|---|---|---|
| Accreditor | **one PIN per person** | View only. Sees only the programs and areas the admin opened. No Drive links, no "Open in new tab", no right-click. A transparent cover sits over the preview's "open in new window" button. Optional watermark with **their name** and the date. |
| Coordinator | **one shared PIN** | Every program and area, including files uploaded by others. Add keywords to any file, **＋** on each indicator and subfolder in the file tree (opens that Drive folder), **Check now**, progress and missing-document markers. |
| Admin | one PIN | Everything a coordinator can do, plus the **Admin panel**: which programs/areas accreditors see, watermark on/off, Refresh / Rebuild / Issues. |

All PINs live in the **main** program's Sheet (Program 1) and work for every program. PINs are *light protection only*: the documents themselves are "anyone with the link", so someone determined (e.g. with browser developer tools) can still find a file's link.

---

## 0. Smoke test (do this FIRST, about 20 minutes)

TUP's Google Workspace settings could block the two things this design needs. Find out now:

1. **External link sharing.** Right-click one evidence file → Share → General access → **Anyone with the link · Viewer**. Then open the link in an **incognito window with a personal (non-TUP) Gmail account**, or signed out. It must open.
   *If "Anyone with the link" is greyed out, TUP blocks external sharing. Ask the TUP Google Workspace admin to allow it for your account or OU. Without it, external accreditors cannot open the documents at all.*
2. **Public web app.** In any Google Sheet: Extensions → Apps Script, then paste:
   ```js
   function doGet() { return ContentService.createTextOutput('{"ok":true}').setMimeType(ContentService.MimeType.JSON); }
   ```
   Deploy → New deployment → Web app → Execute as **Me** → Who has access **Anyone** → Deploy. Open the `/exec` URL in incognito. You should see `{"ok":true}`.
   *If "Anyone" is not offered (only "Anyone within TUP"), use **Plan B** at the end of this README.*

---

## 1. Try the website locally (mock data, no backend)

1. Open the `web/` folder in VS Code and start **Live Server** (extension), or in a terminal:
   ```
   cd web
   python -m http.server 8000
   ```
   Then open http://localhost:8000. Opening `index.html` by double-click will **not** work, because browsers block modules on `file://`.
2. `config.js` starts with `mode: 'mock'`, so the site uses `web/data/mock-p1.json` and `mock-p2.json`.
3. Mock PINs: **111111** = Dr. Reyes (accreditor), **333333** = Dr. Cruz (accreditor), **222222** = coordinators (shared), **000000** = Admin. Mock keyword edits and admin settings are saved in your browser only.
4. Use `?mock=1` / `?mock=0` in the address bar to switch modes without editing the file.

---

## 2. Google Drive

Your folders already exist, one root per program:
```
Program 1 - AACCUP/
  Area I - Vision, Mission, Goals and Objectives/
    Parameter A - Statement of Vision, Mission, Goals and Objectives/
      S.1 - The institution has a clearly stated vision and mission/   ← files go here
      S.2 - …/   I.1 - …/   O.1 - …/
```
- Name variations are fine: `AREA II – Faculty`, `Area 2 Faculty`, `Param. B: …`, `S2. Goals`, `O1 - …`. Dashes, en/em dashes, colons, extra spaces and any letter case all work.
- An extra level of **S / I / O group folders** under a parameter (e.g. `System Inputs and Processes › S.1 …`) is also understood.
- An indicator folder's **Description** (Drive → right-click → File information → Details → Description), if set, becomes the full indicator text shown on the site.
- Subfolders inside an indicator (e.g. sub-indicators `I.1.6.1 › I.1.6.1.3. Students`) are read up to 6 levels deep. Their files are listed under the indicator, labeled with the subfolder path.
- Folders starting with `_` are ignored.

**Sharing** (for each program root):
- General access: **Anyone with the link · Viewer**, so accreditors can open the files.
- Coordinators: **Editor**, so they can upload. In My Drive, Editors *can* move, rename or delete folders, so the coordinator guide tells them not to. Renaming is harmless (folder IDs are used), and moves and deletions are reported in the admin Issues list.

---

## 3. Backend: one Google Sheet per program

Do this for **Program 1** first, then copy it for Program 2 (step 3.9).

### 3.1 Create the Sheet and paste the code
1. Create a Google Sheet, e.g. `AACCUP Portal - Program 1`. Keep it in **your** Drive and do not share it with coordinators (they never need it).
2. Extensions → **Apps Script**.
3. Project Settings (⚙️) → tick **Show "appsscript.json" manifest file in editor**.
4. Back in Editor: replace the contents of `appsscript.json` with `apps-script/appsscript.json`. This enables the **Drive API v3** advanced service.
5. Rename `Code.gs` and paste `apps-script/Code.gs`. Add files (＋ → Script) named `Security`, `Structure`, `Snapshot`, `Api` and paste each one.
6. Save (Ctrl+S). Close the editor and **reload the Sheet**. An **AACCUP** menu appears.

### 3.2 Setup
AACCUP → **1. Setup / check settings**. Approve the permissions (Google warns "unverified app" because it's your own script: Advanced → Go to …). Then answer:
- Program code: `p1`, which must match `code` in `config.js`
- Program name: e.g. `Bachelor of Technical-Vocational Teacher Education`
- Root folder: paste the link to `Program 1 - AACCUP`
- **Main program?** Answer **YES** for Program 1. This Sheet then holds every PIN and handles all logins, for both programs.

Setup creates the tabs (Config, Structure, Keywords, Access, Log) and a private folder `_system AACCUP p1 (do not share)` in your My Drive for `snapshot.json` and `issues.json`.

### 3.3 Build the structure
AACCUP → **2. Build structure**. Then open the **Structure** tab:
- Rows with status `badName` didn't match the naming pattern. Either fix the name in Drive, or type into the yellow columns:
  - `codeOverride`: e.g. `II`, `C`, or `S.3`
  - `nameOverride` / `textOverride`: official name or indicator text
  - `hidden`: `TRUE` to hide a junk folder (and everything inside it)
- Run Build structure again. Your overrides are kept on every rebuild.

### 3.4 Build the first snapshot
AACCUP → **3. Build snapshot now**. It reports documents, indicators and issues. A normal run takes a few seconds.

### 3.5 PINs (main Sheet only)
Every PIN is exactly **6 digits** and must be unique, because the PIN alone decides who is logging in. The menu refuses a PIN that is already in use. Leave a PIN prompt blank to get a random one.
- AACCUP → **Set admin PIN**.
- AACCUP → **Set coordinator PIN (shared)**. Give this one PIN to all area coordinators.
- Fill the **Access** tab: one row per accreditor, with their name in `accreditorName` (e.g. `Dr. Reyes`). Leave `pinHash` blank. The name appears on the site, in the watermark and in the Log.
- AACCUP → **Generate accreditor PINs (Access list)**. A dialog shows each new PIN **once**: copy them now and give each accreditor their own. Only hashes are stored (salted SHA-256, with the salt in Script Properties).
- To add one accreditor or change one PIN later: AACCUP → **Set one accreditor PIN**. To remove an accreditor, delete their row.
- A login lasts 12 hours. After the visit, delete the accreditors' rows (or regenerate their PINs) and change the coordinator PIN; existing sessions end within 12 hours.
- Because coordinators share one PIN, the Log and the Keywords tab show "Coordinator" rather than a person's name.

*Coming from an older version?* The Access tab used to list coordinators. Setup renames that tab to **Access (old coordinators)** (nothing is deleted) and creates a fresh Access tab for accreditors. The old per-coordinator PINs and any shared accreditor PIN stop working: set the new PINs above.

### 3.6 Auto-refresh
AACCUP → **Install 5-minute auto-refresh**. Each run only lists files in the known folders (about 15–25 Drive API calls), so it fits easily in Workspace quotas.

### 3.7 Deploy the web app
1. In the Apps Script editor: **Deploy → New deployment** → ⚙️ **Web app**.
2. Execute as: **Me**. Who has access: **Anyone**. Then **Deploy** and copy the **Web app URL** (ends in `/exec`).
3. Test it in incognito: `…/exec?action=ping` should return `{"ok":true,…}`. `…/exec?action=snapshot` should now say `"error":"expired"`, because the file list needs a login.

**After any code change:** Deploy → **Manage deployments** → ✏️ → Version: **New version** → Deploy. The URL stays the same.

### 3.8 Check the status
AACCUP → **Status & deploy checklist** shows the Sheet role (main/linked), the trigger, last scan, PINs, accreditor access and URL.

### 3.9 Program 2 (a linked Sheet: no PINs of its own)
1. File → **Make a copy** of the Program 1 Sheet. This copies the script too, but **not** the trigger, Script Properties or deployment.
2. In the copy, clear the values in **Config** for `programCode`, `programName`, `rootFolderId`, `systemFolderId`, `snapshotFileId`, `issuesFileId`, `authMode`, `adminPinHash` and `coordinatorPinHash`. Delete all rows below the headers in **Structure**, **Keywords**, **Access** and **Log**.
3. In the **Program 1** Sheet: AACCUP → **Show link key** and copy the key.
4. In the copy, repeat 3.2 with code `p2`. Answer **NO** to "Main program?" and paste the link key. Then do 3.3, 3.4, 3.6, 3.7 and 3.8. Skip 3.5: the PINs from Program 1 work here too.

The link key lets Program 2 accept the logins made through Program 1. Keep it private. To link an existing Sheet later: AACCUP → **Link to main program**.

---

## 4. Point the website at the backend

Edit `web/js/config.js`:
```js
mode: 'live',
programs: [
  { code: 'p1', name: 'BTVTEd …', source: 'api',
    apiUrl: 'https://script.google.com/macros/s/AKfy…/exec', … },
  { code: 'p2', … },
],
```
The **first** program in the list must be the main one (Program 1), because logins are sent to it.
Don't put Drive folder links in `config.js`: it is public. Coordinators and the admin get each program's Drive root link from the server after they log in.

Also set `school`, `college`, `colors` and `logos`. Put logo files in `web/assets/` (PNG or SVG, square), e.g. `{ src: 'assets/tup-logo.png', alt: 'TUP logo' }`.

`viewerShield` sets the size of the transparent cover over the Drive preview's "open in new window" button (top-right corner), shown to accreditors only. After going live, open a PDF as an accreditor. If the button is still clickable, make `width` / `height` a little bigger. Scrolling, page number and zoom in the rest of the preview stay usable.

**Never put PINs or secrets in `config.js`.** It is public.

---

## 5. Publish on GitHub Pages

1. Create a free GitHub account if needed, then **New repository** (e.g. `aaccup-cie`), **Public**.
2. Click **uploading an existing file** and drag in **everything inside `web/`** (`index.html`, `css/`, `js/`, `data/`, `assets/`, `.nojekyll`). Do not upload the `web` folder itself; its contents must be at the repository root. Commit.
3. Repository **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save.
4. After about 1 minute the site is at `https://<your-username>.github.io/aaccup-cie/`.
5. To update later, upload the changed files again. GitHub Pages caches for about 10 minutes. If a change doesn't show, bump the `?v=` numbers in `index.html` (now `styles.css?v=3` and `app.js?v=3`; change both to 4, and so on).
6. This update removed `js/team.js` and added `js/staff.js` and `js/admin.js`. Delete `team.js` from the repository too (it is no longer used).

The `data/mock-*.json` files are harmless to publish; they are only used in mock mode.

---

## 6. Final test checklist

- [ ] Incognito, on a phone **and** a laptop, outside the TUP network: the site opens on the PIN screen. An accreditor's PIN, the coordinator PIN and the admin PIN each log in.
- [ ] **Accreditor:** home shows only the programs you opened; area selection shows only the areas you ticked. Open a PDF, a Google Doc, a Sheet, Slides and an image. Scrolling and the page number work, the preview's top-right "open in new window" button does **not** respond, there is no "Open in new tab", right-click does nothing, and the watermark shows (when on).
- [ ] Prev / Next and the ← / → keys move through the area's documents. The tree's filter box finds a file by name or keyword.
- [ ] Copy a deep link (e.g. `…/#/p1/I/A/S.1`), open it on another device: after login it lands on that indicator.
- [ ] Search: multiple words, a keyword-only match ("Matched keyword: …"), accents, and the × button.
- [ ] **Coordinator:** can open every area of both programs. The **＋** on an indicator (and on a subfolder) row opens the right Drive folder. Upload a file, tap **Check now**: it shows "1 new file" within seconds. Save a keyword on a file someone else uploaded, then search for it.
- [ ] **Admin:** Admin panel → untick an area, Save; log in as accreditor in another browser: that area is gone. Turn the watermark off and on.
- [ ] Put a test file directly in a Parameter folder: Admin → Issues shows it as misplaced.
- [ ] Ten wrong PINs in a row pause logins for 5 minutes.
- [ ] Temporarily break `apiUrl`: the site shows the saved copy plus a notice. Then restore it.
- [ ] Projector: `Ctrl +` / `Ctrl -` zoom stays readable.

---

## 7. During the accreditation visit

- Keep the trigger **on**. Don't run **Rebuild structure** unless folders changed.
- Before the visit: Admin panel → open only the programs and areas the accreditors should see.
- Admin panel: log in with the admin PIN, then **Admin panel** in the header (or `…/#/admin/p1`).
- If anything breaks, coordinators and the admin still see each program's Drive root link in the offline notice (once that program's file list has loaded in their tab).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No apiUrl set in config.js" | Paste the `/exec` URL into `config.js` and set `mode: 'live'`. |
| Site shows old data | Admin panel → Refresh now. Check AACCUP → Status that the trigger is ON. |
| New folder not showing | Admin → Rebuild structure (or Sheet menu → Build structure, then Build snapshot). |
| A document says "You need access" | That file isn't "Anyone with the link". Fix it in Drive (usually files uploaded before the folder was shared, or moved in from elsewhere). |
| Login: "Too many wrong PINs" | Wait 5 minutes. (Ten wrong PINs from anyone pause all logins briefly.) |
| Login says "Logins go through the main program" | The first program in `config.js` must be the main Sheet (Setup answered YES). |
| Program 2 says "not linked to the main program (link key mismatch)" | Program 2's link key differs from Program 1's: AACCUP → Link to main program, paste the key from Program 1, then deploy a new version. |
| An accreditor sees "not open yet" | Admin panel → tick "Accreditors can open …" for that program. |
| Code changes not live | Deploy → Manage deployments → Edit → **New version**. |
| `Drive is not defined` | The manifest wasn't saved: re-paste `appsscript.json`, or Services ＋ → Drive API v3. |

## Plan B: if TUP blocks "Anyone" web apps

The site can run from a static snapshot file instead of the live web app:
1. Run AACCUP → Build snapshot now. Open your `_system AACCUP p1` folder and download `snapshot.json`.
2. Save it as `web/data/snapshot-p1.json` (and `snapshot-p2.json`), and set `source: 'static'` for that program in `config.js`.
3. Upload to GitHub. Repeat whenever documents change (e.g. twice a day).

Logins, keyword editing and the admin panel need the web app, so Plan B has **no PIN screen**. Set `requireLogin: false` in `config.js`: everyone then views as an accreditor, and the static file (all areas) is public. Before downloading the snapshot, hide unwanted folders with `hidden = TRUE` in the Structure tab. Type keywords directly into the **Keywords** tab (`fileId`, `keywords`); they're merged at the next snapshot.

## Security notes
- PINs are checked **only on the server** (the main Sheet), stored as salted SHA-256 hashes, and rate-limited (10 wrong PINs per 5 minutes). A correct PIN gets a signed 12-hour session token. The browser keeps the token in the current tab only and never stores the PIN.
- The file list itself needs a token. Accreditors receive only the areas the admin opened, without Drive folder IDs or "open in Drive" links. Coordinator and admin actions are checked on the server.
- Logging out (or closing the tab) clears the saved copy of the file list from the browser.
- The cover over the preview and the disabled right-click only stop *casual* copying. The documents are still "anyone with the link", and the file ID is inside the preview's address. Don't put anything confidential in the evidence folders.
