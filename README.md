# Avere Forza HQ — Dashboard + Secure Backend (Render-ready)

A private control centre for running the Avere Forza brand day-to-day: photo posting queues, a live Dropbox content library, an influencer/creator database, and a quick-capture idea notepad — protected behind a login screen, hardened for production, and ready to deploy on Render.

## Architecture

```
Browser  →  Login screen  →  Express server (session-protected, rate-limited)  →  Dropbox   (media only, READ-ONLY)
                                                                                →  SQLite app database (everything else, read/write)
                                                                                →  SQLite session store (login sessions)
                                                                                →  DATA_DIR  (one folder holding all persistent files)
```

Nothing is publicly reachable just by knowing the URL — every page and every `/api/...` route (except the health check and the login endpoint itself) requires a valid, signed-in session.

## What's in this project

```
index.html, style.css, script.js   — the dashboard (unchanged UI/navigation/features)
login.html                          — the sign-in screen
render.yaml                         — one-click Render Blueprint (optional but recommended)
server/
  index.js                          — the whole backend: auth, rate limiting, HQ data API, Dropbox API, static files
  package.json
  .env.example                      — every environment variable this app needs, with blank placeholders
  lib/db.js                         — SQLite app database (queues, influencers, ideas, activity log)
  lib/dropbox.js                    — read-only Dropbox API helper
```

The repository root holds the frontend files; the Express app lives in `server/`. Render (and Node) run the server from that subfolder while it still serves the frontend files that sit one level up — see the deployment section below for exactly how that's configured.

---

## 1. Persistent storage — `DATA_DIR`

Every file the app needs to remember between restarts lives under one folder, set by the `DATA_DIR` environment variable:

- the SQLite app database (`avereforza.db`)
- the SQLite session database (`sessions.db`)
- the Dropbox sync catalogue (`dropbox-library.json`)
- uploaded/swapped queue photos (`uploads/`)

Locally, leave `DATA_DIR` unset and the app automatically uses `server/data/` — nothing to configure. In production on Render, it's set to `/var/data`, which is where you'll attach a persistent disk (step-by-step below). The app creates every folder it needs automatically.

## 2. Render compatibility

- The server listens on `process.env.PORT || 4000` and binds to `0.0.0.0`, exactly what Render expects.
- One Express server serves the dashboard, the login page, and every `/api/...` route — the whole app is a single Render Web Service, all on one domain.
- **Root Directory stays the repository root** — not `server` — because `server/index.js` needs to reach `index.html`, `login.html`, `style.css`, and `script.js`, which live one level up from it. Render instead `cd`s into `server` as part of the Build and Start Commands (see the deployment steps below). If Root Directory were set to `server`, the Express app would never see the frontend files and every page would fail to load.
- `GET /api/health` returns `{ "status": "ok" }` — use this to confirm the backend is alive.
- The SQLite app database is created automatically the first time the server starts, with the same starter example data (2 sample influencers, 1 sample idea, empty queues) it shipped with before.

## 3. Login protection

A single-user login screen (`login.html`) sits in front of the entire dashboard.

- Credentials are checked **only on the server**, against the environment variables `HQ_USERNAME` and `HQ_PASSWORD` — never sent to, or stored in, the browser.
- A signed session cookie (secret: `SESSION_SECRET`) is issued on successful login. It is `httpOnly` (invisible to JavaScript), `secure` in production (HTTPS-only), and uses `sameSite: lax`.
- **Sessions are stored in SQLite, not memory.** Earlier versions of this app used express-session's default in-memory store, which loses every logged-in session on a server restart and isn't safe for production. Sessions now live in `sessions.db` under `DATA_DIR`, on the same persistent disk as everything else — a restart or redeploy no longer force-logs-out anyone unexpectedly (though sessions still expire normally after 7 days).
- **`/api/login` is rate-limited**: at most 10 attempts per IP address per 15-minute window. This only applies to the login endpoint — every other API route and normal dashboard use is unaffected and never throttled.
- Every `/api/...` route except `/api/health`, `/api/login`, and `/api/logout` returns `401 Unauthorized` without a valid session.
- The dashboard's HTML itself is also gated: visiting the site while logged out redirects straight to the login page.
- Every frontend API call — including Dropbox Refresh and photo uploads, not just the main data load — consistently redirects to `/login.html` the moment the server responds with 401. So if your session expires while you're mid-edit, the very next action (typing a caption, refreshing Dropbox, swapping a photo) sends you back to sign in again, rather than silently failing.
- A **Log out** button lives in Settings → Account.

## 4. Dropbox stays read-only

The server only ever calls Dropbox's `list_folder`, `get_thumbnail_v2`, and `get_temporary_link` — all read-only. There is no code path anywhere that renames, moves, uploads, edits, or deletes a Dropbox file. Credentials (`DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, `DROPBOX_CONTENT_FOLDER`) live only in server environment variables — never in `index.html`, `script.js`, browser storage, or a URL, and never committed to the project. The Content Library now describes itself in the dashboard as the live view of `/AVERE CONTENT/AF LIBRARY`, not a one-off test import.

## 5. Upload hardening

Queue photo uploads keep the existing 25 MB size limit, and now also check server-side that the uploaded file is actually an image (`image/jpeg`, `png`, `webp`, `gif`, or `heic`/`heif`) before it's saved. The frontend's `accept="image/*"` was always just a UI hint — a visitor could previously bypass it and upload any file type directly to the upload endpoint. That's now rejected by the server itself with a clear error message, regardless of what the browser sends.

## 6. Stored text is now escaped before display

Anywhere the dashboard displays a value someone typed or that came from Dropbox — captions, video ideas, influencer names/notes, activity log lines, Dropbox filenames — that value is passed through a small `escapeHtml()` helper in `script.js` before being inserted into the page. This means a caption or influencer note can never be interpreted as HTML or JavaScript by the browser, even if it contains characters like `<` or `"`. Nothing about how the dashboard looks or behaves changed — this is purely a safety net around how existing data is displayed.

## 7. Wording corrections

- The sidebar footer no longer says data is "stored privately in this browser" — it now correctly says editable HQ data is stored securely on the server, and Dropbox media stays read-only.
- The Danger Zone description no longer says data is stored "in this browser" — it now says it wipes queues, ideas, and influencer records stored on the server.
- The Dropbox Content Library section no longer describes itself as a "first test" importing 5 files — it now describes itself as the live view of `/AVERE CONTENT/AF LIBRARY`, refreshed on demand.

## 8. Dependency and Node version pinning

- **Node version is pinned to Node 24** — both `.node-version` (repository root) and `server/package.json`'s `"engines": { "node": "24.x" }` specify Node 24 specifically, not an open-ended `>=18`. Render reads `.node-version` automatically and provisions that Node major version; `engines.node` backs that up so a plain `npm install` also warns if run on the wrong version. This means the project won't silently jump to Node 25 or later when it's released.
- **Multer upgraded** from `^1.4.5-lts.1` to `^2.2.0`. Multer 2's public API for the pieces this project uses — `multer.diskStorage`, the `limits.fileSize` cap, `fileFilter`, and `upload.single("photo")` — is unchanged from Multer 1, so no code changes were needed in `server/index.js`; the 25 MB size limit and the server-side image-only check both continue to work exactly as before.
- **Express and express-session bumped** to their current stable releases within the same major versions already in use (`express` ^4.21.2, `express-session` ^1.18.1) — no breaking changes, same session/cookie behaviour.
- **A note on `package-lock.json`:** generating a genuine lockfile requires contacting the npm registry to resolve exact versions and integrity hashes, which isn't possible from where this project was assembled. Rather than hand-write a lockfile with fabricated hashes (which would fail or mislead more than help), the recommended one-time step is: after downloading this project, run `npm install` once inside the `server/` folder on any machine with Node 24 and internet access, then commit the `package-lock.json` it generates. From that point on, every Render deploy (and every teammate's machine) installs the exact same dependency versions. Render's build command (`npm install`) will also generate one automatically on first deploy if none is committed — committing it yourself just makes that pinning explicit and reviewable in your repository.

## 9. Architecture — unchanged

- Dropbox: read-only, unchanged.
- SQLite app database: fully editable, unchanged.
- `DATA_DIR=/var/data` in production: unchanged.
- One Express Web Service serving both frontend and API: unchanged.
- `/api/health`: unchanged.
- Dropbox credentials only via environment variables: unchanged.
- No social platform (Instagram, TikTok, YouTube, Pinterest) is connected, and nothing posts automatically. The future path remains **Avere Forza HQ → Zapier → social platform**, not yet implemented — the existing stub functions in `script.js` (`postToPinterest`, `postToInstagramSpam`, `postToInstagramReelsAndShorts`) are where that would eventually plug in.
- No real credentials are included anywhere in this project.

---

## Deploying to Render — step by step (no coding required)

### A. Put the project on GitHub

1. Go to [github.com](https://github.com) and sign in (create a free account if you don't have one).
2. Click the **+** in the top right → **New repository**. Name it something like `avere-forza-hq` → **Create repository**.
3. On the new repo's page, click **uploading an existing file** (or drag-and-drop). Upload every file and folder from this project, keeping the same structure — `index.html`, `login.html`, `style.css`, `script.js`, and `render.yaml` at the top level, with `server/` (and its `lib/` subfolder) as a subfolder.
4. Commit the upload (the green **Commit changes** button).

### B. Create the Render Web Service

**Easiest path — using the Blueprint file included (`render.yaml`):**

1. Go to [render.com](https://render.com) and sign in.
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account if prompted, then select the `avere-forza-hq` repository.
4. Render reads `render.yaml` automatically and shows you the service plus a persistent disk it's about to create. Click **Apply**.
5. Render will then ask you to fill in the environment variables marked secret (`HQ_USERNAME`, `HQ_PASSWORD`, `SESSION_SECRET`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`) — enter real values for each.

**Manual path (if you'd rather not use the Blueprint):**

1. On Render, click **New +** → **Web Service** → connect and select your repository.
2. **Root Directory**: leave this **blank** (repository root) — do **not** set it to `server`. The Express app needs to reach the frontend files that live outside the `server` folder.
3. **Build Command**: `cd server && npm install`
4. **Start Command**: `cd server && npm start`
5. **Instance Type**: Starter (or Free, for testing) is enough to begin.
6. Under **Environment**, add each variable from `server/.env.example` with a real value:
   - `HQ_USERNAME`, `HQ_PASSWORD` — pick your own login credentials for the dashboard.
   - `SESSION_SECRET` — any long random string (e.g. mash your keyboard for 40 characters).
   - `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` — your Dropbox app credentials.
   - `DROPBOX_CONTENT_FOLDER` — `/AVERE CONTENT/AF LIBRARY` (or wherever your content lives).
   - `DATA_DIR` — `/var/data`
   - `NODE_ENV` — `production`
7. Attach the persistent disk: under **Disks**, click **Add Disk**. Name it anything, set **Mount Path** to `/var/data`, size 1 GB is plenty to start.
8. Click **Create Web Service**.

### C. Deploy

Render builds and starts the app automatically after you click Create/Apply. Watch the **Logs** tab — when you see a line like `Avere Forza HQ server running on port 10000`, it's live. Render gives you a URL like `https://avere-forza-hq.onrender.com`.

### D. Test that it's working

1. **Health check** — visit `https://your-app.onrender.com/api/health`. You should see `{"status":"ok",...}`.
2. **Login** — visit `https://your-app.onrender.com` (the root URL). You should be redirected to the login screen. Enter the `HQ_USERNAME`/`HQ_PASSWORD` you set in Render's environment variables. You should land on the dashboard.
3. **Dropbox Refresh** — go to the Dropbox Content Library tab and click "Refresh Dropbox Content." You should see your real files listed with thumbnails/previews.
4. **Data persists** — add a video idea, or edit an influencer's status, then refresh the browser page (or close and reopen the tab). The change should still be there — that confirms the database (and its persistent disk) is working correctly.
5. **Log out** — go to Settings → Account → Log out. You should be returned to the login screen, and the dashboard should no longer be reachable until you sign in again.

---

## What's editable, and where it lives

| Area | Editable? | Stored in |
|---|---|---|
| Pinterest / IG Spam / Personal queues — captions, statuses, swapped photos | Yes | Database + uploaded photos, both under `DATA_DIR` |
| Video ideas | Yes | Database |
| Influencer database | Yes | Database |
| Activity log | Yes (auto-logged) | Database |
| Dropbox Content Library | Read-only, always live from Dropbox | Not stored — fetched fresh each Refresh |
| Login sessions | N/A (system-managed) | Session database under `DATA_DIR` |

## Direct Dropbox API vs. Zapier — unchanged recommendation

The Content Library calls the Dropbox API directly (via the credentials above), not Zapier — it needs synchronous, on-demand calls with cursor-based delta sync for duplicate-free refreshing, which Zapier's trigger-based actions aren't built for. Zapier remains the right tool for the future publishing stage.

## Future: connecting the queues to Zapier for publishing

Still not implemented, by design — no social platform is connected yet, and nothing posts automatically. When you're ready, the existing stub functions in `script.js` (`postToPinterest`, `postToInstagramSpam`, `postToInstagramReelsAndShorts`) are where a future `/api/publish/...` endpoint would plug in, keeping the flow **Avere Forza HQ → Zapier → social platform** as its own separate integration from both Dropbox and the login system.

## Security notes

- `server/.env` (for local use) and everything under `DATA_DIR` are git-ignored — never commit real credentials or your live database.
- Session cookies are `httpOnly`, `secure` in production, and `sameSite: lax`. Sessions now persist in SQLite, so a server restart no longer signs everyone out.
- `/api/login` is rate-limited to slow down password guessing; no other route is throttled.
- Queue photo uploads are checked server-side to ensure they're actually image files, regardless of what the browser claims.
- All displayed captions, ideas, influencer details, activity log entries, and Dropbox filenames are HTML-escaped before being shown, so stored text can never execute as code in the browser.
- Rotate `HQ_PASSWORD` and `SESSION_SECRET` periodically the same way you'd rotate any shared password.
