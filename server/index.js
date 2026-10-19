/* =========================================================
   server/index.js
   Express server for Avere Forza HQ — production-ready for Render.

   Responsibilities:
   - Serves the dashboard frontend (index.html / style.css / script.js)
     and the login page (login.html), from the project root.
   - Gates the dashboard and every /api/... route (except /api/health,
     /api/login, /api/logout) behind a server-side session, persisted
     in SQLite (not the default in-memory store) so sessions survive
     a server restart and work correctly with more than one instance.
   - Rate-limits /api/login specifically, to slow down password
     guessing, without limiting normal signed-in dashboard use.
   - Exposes a READ-ONLY Dropbox Content Library API — never renames,
     moves, uploads, edits, or deletes anything in Dropbox.
   - Exposes a fully read/write API for everything else (queues,
     influencers, ideas, activity log), backed by a real SQLite
     database so edits persist across restarts/redeploys/devices.
   - Queue photo uploads are restricted server-side to image files
     only (not just the frontend's accept="image/*" hint).
   - All persistent files (app database, session database, Dropbox
     sync catalog, uploaded queue photos) live under one configurable
     folder: DATA_DIR. Defaults to ./data locally; set to /var/data
     on Render, which is where the persistent disk is mounted.
========================================================= */

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const SqliteStore = require("better-sqlite3-session-store")(session);
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { listFolder, getTemporaryLink, getThumbnail } = require("./lib/dropbox");
const store = require("./lib/db");

const app = express();
const PORT = process.env.PORT || 4000;
const IS_PRODUCTION = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

// ---------- persistent storage: everything lives under DATA_DIR ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DROPBOX_CATALOG_FILE = path.join(DATA_DIR, "dropbox-library.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const SESSIONS_DB_PATH = path.join(DATA_DIR, "sessions.db");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const CONTENT_FOLDER = process.env.DROPBOX_CONTENT_FOLDER || "/AVERE CONTENT";
const ZAPIER_PINTEREST_WEBHOOK_URL = process.env.ZAPIER_PINTEREST_WEBHOOK_URL || "";
const ZAPIER_PINTEREST_CALLBACK_SECRET = process.env.ZAPIER_PINTEREST_CALLBACK_SECRET || "";
const ZAPIER_INSTAGRAM_WEBHOOK_URL = process.env.ZAPIER_INSTAGRAM_WEBHOOK_URL || "";
const ZAPIER_INSTAGRAM_CALLBACK_SECRET = process.env.ZAPIER_INSTAGRAM_CALLBACK_SECRET || "";
const PROJECT_ROOT = path.join(__dirname, "..");

const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif", "heic"];
const VIDEO_EXT = ["mov", "mp4", "m4v", "avi", "mkv"];

// Queue photo uploads: same size limit as before, plus a server-side check
// that the uploaded file is actually an image — the frontend's
// accept="image/*" is just a UI hint and can't be trusted on its own.
const ALLOWED_IMAGE_MIME = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-z0-9.\-_]/gi, "_")}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only image files (JPEG, PNG, WEBP, GIF, HEIC) can be used for queue photos."));
  },
});

// Render (and most hosts) sit behind a reverse proxy that terminates HTTPS —
// this tells Express to trust the proxy's "is this request secure" header,
// which is required for secure cookies to work correctly in production.
app.set("trust proxy", 1);
app.use(express.json());

/* =========================================================
   AUTHENTICATION
   Single-user login, checked server-side against HQ_USERNAME /
   HQ_PASSWORD (env vars — never sent to the browser). A signed,
   httpOnly session cookie is the only thing the browser holds.
   Sessions themselves live in a small SQLite file under DATA_DIR,
   so they're not lost on every server restart the way the default
   express-session MemoryStore would be, and they're safe to run
   in production.
========================================================= */
if (!process.env.SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET is not set. Using an insecure default — set it before deploying.");
}

const sessionDb = new Database(SESSIONS_DB_PATH);
const sessionStore = new SqliteStore({
  client: sessionDb,
  expired: {
    clear: true,
    intervalMs: 1000 * 60 * 15, // sweep expired sessions every 15 minutes
  },
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
}));

// Rate-limit failed-login guessing specifically. This does NOT apply to any
// other route, so normal signed-in dashboard use is never throttled.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait 15 minutes and try again." },
});

// Public API routes that must work without a session (login itself, logout,
// and a health check for Render/uptime monitoring).
const PUBLIC_API_PATHS = new Set(["/api/health", "/api/login", "/api/logout"]);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.post("/api/login", loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const validUser = process.env.HQ_USERNAME;
  const validPass = process.env.HQ_PASSWORD;

  if (!validUser || !validPass) {
    return res.status(500).json({ error: "Login isn't configured on the server yet (missing HQ_USERNAME/HQ_PASSWORD)." });
  }
  if (username === validUser && password === validPass) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Incorrect username or password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// Public callback used only by Zapier after Pinterest successfully creates a Pin.
// It is intentionally outside the authenticated /api middleware because Zapier
// does not have an HQ browser session. A separate high-entropy callback secret
// must match before any queue data can be changed.
app.post("/api/publish/pinterest/callback", (req, res) => {
  if (!ZAPIER_PINTEREST_CALLBACK_SECRET) {
    return res.status(503).json({ error: "Pinterest callback is not configured yet." });
  }

  const suppliedSecret = String(req.get("x-af-callback-secret") || req.body?.callback_secret || "");
  const expectedSecret = String(ZAPIER_PINTEREST_CALLBACK_SECRET);
  const supplied = Buffer.from(suppliedSecret);
  const expected = Buffer.from(expectedSecret);
  if (!suppliedSecret || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: "Invalid callback secret." });
  }

  const queueItemId = String(req.body?.queue_item_id || "").trim();
  const pinId = String(req.body?.pin_id || req.body?.id || "").trim();
  if (!queueItemId || !pinId) {
    return res.status(400).json({ error: "queue_item_id and pin_id are required." });
  }

  const item = store.getQueueItem("pinterest", queueItemId);
  if (!item) return res.status(404).json({ error: "Pinterest queue item not found." });

  const pinUrl = `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`;
  const updated = store.updateQueueItem("pinterest", queueItemId, {
    status: "posted",
    pinterestPinId: pinId,
    pinterestPinUrl: pinUrl,
    publishedAt: new Date().toISOString(),
  });
  if (item.dropboxFileId) store.markContentPosted(item.dropboxFileId, "pinterest", item.id);
  store.addActivity(`Pinterest confirmed live: ${(item.title || item.caption || item.name).slice(0, 80)}`);
  return res.json({ success: true, item: updated, pin_url: pinUrl });
});

// Public callback used only by Zapier after Instagram successfully publishes a photo.
// It mirrors the Pinterest callback: Zapier does not have an HQ browser session,
// so a separate high-entropy callback secret must match before any queue data changes.
app.post("/api/publish/instagram/callback", (req, res) => {
  if (!ZAPIER_INSTAGRAM_CALLBACK_SECRET) {
    return res.status(503).json({ error: "Instagram callback is not configured yet." });
  }

  const suppliedSecret = String(req.get("x-af-callback-secret") || req.body?.callback_secret || "");
  const expectedSecret = String(ZAPIER_INSTAGRAM_CALLBACK_SECRET);
  const supplied = Buffer.from(suppliedSecret);
  const expected = Buffer.from(expectedSecret);
  if (!suppliedSecret || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: "Invalid callback secret." });
  }

  const queueItemId = String(req.body?.queue_item_id || "").trim();
  const mediaId = String(req.body?.instagram_media_id || req.body?.media_id || req.body?.instagram_post_id || req.body?.id || "").trim();
  const permalink = String(req.body?.permalink || req.body?.instagram_permalink || req.body?.url || "").trim();
  const callbackStatus = String(req.body?.status || "posted").trim().toLowerCase();
  const callbackError = String(req.body?.error || "").trim();

  if (!queueItemId) {
    return res.status(400).json({ error: "queue_item_id is required." });
  }

  const item = store.getQueueItem("spam", queueItemId);
  if (!item) return res.status(404).json({ error: "IG Spam queue item not found." });

  if (callbackStatus === "failed" || callbackError) {
    const updated = store.updateQueueItem("spam", queueItemId, { status: "failed" });
    store.addActivity(`Instagram publish failed: ${(item.caption || item.name).slice(0, 80)}`);
    return res.json({ success: true, status: "failed", item: updated });
  }

  const updated = store.updateQueueItem("spam", queueItemId, {
    status: "posted",
    instagramMediaId: mediaId,
    instagramPermalink: permalink,
    publishedAt: new Date().toISOString(),
  });
  if (item.dropboxFileId) store.markContentPosted(item.dropboxFileId, "spam", item.id);
  store.addActivity(`Instagram confirmed live: ${(item.caption || item.name).slice(0, 80)}`);
  return res.json({ success: true, item: updated, permalink });
});

// Everything else under /api/ requires a valid session.
app.use("/api", (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: "Not authenticated" });
});

// The dashboard page itself is also gated — an unauthenticated visitor is
// sent to the login page instead of ever receiving the dashboard HTML.
function requireAuthPage(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.redirect("/login.html");
}

app.get(["/", "/index.html"], requireAuthPage, (req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, "index.html"));
});

// Explicitly-named static frontend files only — deliberately NOT a blanket
// express.static(PROJECT_ROOT), which would also expose the server/ folder
// (including .env) to anyone who requested it directly.
app.get("/login.html", (req, res) => res.sendFile(path.join(PROJECT_ROOT, "login.html")));
app.get("/style.css", (req, res) => res.sendFile(path.join(PROJECT_ROOT, "style.css")));
app.get("/script.js", (req, res) => res.sendFile(path.join(PROJECT_ROOT, "script.js")));

// Uploaded queue photos are private business content too, so they require
// a session just like the rest of the dashboard.
app.use("/uploads", (req, res, next) => {
  if (req.session && req.session.authenticated) return next();
  return res.status(403).end();
}, express.static(UPLOADS_DIR));

/* =========================================================
   TEMPORARY PUBLISH MEDIA
   Zapier/Pinterest must be able to fetch an image without an HQ login.
   This route exposes only the single queued image named in a short-lived,
   HMAC-signed URL. It does not expose the uploads directory generally.
========================================================= */
function publishSignature(queue, id, expires) {
  const secret = process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me";
  return crypto.createHmac("sha256", secret).update(`${queue}:${id}:${expires}`).digest("hex");
}

app.get("/publish-media/:queue/:id", (req, res) => {
  const { queue, id } = req.params;
  const expires = Number(req.query.expires);
  const sig = String(req.query.sig || "");
  if (!Number.isFinite(expires) || Date.now() > expires) return res.status(403).send("Link expired");
  const expected = publishSignature(queue, id, expires);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send("Invalid link");

  const item = store.getQueueItem(queue, id);
  if (!item || !item.url || !item.url.startsWith("/uploads/")) return res.status(404).send("Image not found");
  const filename = path.basename(item.url.slice("/uploads/".length));
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Image not found");
  res.sendFile(filePath);
});

/* =========================================================
   HQ DATA API — fully read/write, backed by SQLite (server/lib/db.js).
   Completely separate from the Dropbox integration below.
========================================================= */
app.get("/api/state", (req, res) => {
  res.json(store.getFullState());
});

app.patch("/api/queues/:queue/:id", (req, res) => {
  const updated = store.updateQueueItem(req.params.queue, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Queue item not found" });
  res.json(updated);
});

app.post("/api/queues/:queue/:id/photo", upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No photo received" });
  const imageUrl = `/uploads/${req.file.filename}`;
  const updated = store.updateQueueItem(req.params.queue, req.params.id, {
    image_url: imageUrl,
    dropboxFileId: "",
    name: req.file.originalname,
    status: "pending",
    assignedDate: londonDate(),
    autoSelected: false,
    ...(req.params.queue === "pinterest" ? { pinterestPinId: "", pinterestPinUrl: "", publishedAt: "" } : {}),
    ...(req.params.queue === "spam" ? { instagramMediaId: "", instagramPermalink: "", publishedAt: "" } : {}),
  });
  if (!updated) return res.status(404).json({ error: "Queue item not found" });
  res.json(updated);
});

// Assigns an existing Dropbox image to a queue slot without copying, moving,
// renaming, or otherwise modifying the Dropbox file. The HQ stores only the
// Dropbox file ID plus a private thumbnail URL for the dashboard. At publish
// time, the server mints a fresh short-lived Dropbox download link.
app.post("/api/queues/:queue/:id/dropbox", async (req, res) => {
  const queue = req.params.queue;
  if (!["pinterest", "spam"].includes(queue)) {
    return res.status(400).json({ error: "Dropbox selection is currently available for Pinterest and IG Spam queues." });
  }

  const fileId = String(req.body?.fileId || "").trim();
  if (!fileId) return res.status(400).json({ error: "A Dropbox file ID is required." });

  let catalog = loadCatalog();
  let file = catalog.files[fileId];
  if (!file) {
    try {
      const synced = await syncCatalog();
      catalog = synced.catalog;
      file = catalog.files[fileId];
    } catch (err) {
      console.error("Dropbox queue assignment refresh failed:", err);
    }
  }

  if (!file) return res.status(404).json({ error: "That Dropbox file is no longer in the content library." });
  if (!file.isImage) return res.status(400).json({ error: "Choose an image file for this queue slot." });

  const existing = store.getQueueItem(queue, req.params.id);
  if (!existing) return res.status(404).json({ error: "Queue item not found" });

  const previewUrl = `/api/dropbox-thumbnail?id=${encodeURIComponent(file.id)}`;
  const updated = store.updateQueueItem(queue, req.params.id, {
    image_url: previewUrl,
    dropboxFileId: file.id,
    name: file.name,
    status: "pending",
    assignedDate: londonDate(),
    autoSelected: false,
    ...(queue === "pinterest" ? { pinterestPinId: "", pinterestPinUrl: "", publishedAt: "" } : {}),
    ...(queue === "spam" ? { instagramMediaId: "", instagramPermalink: "", publishedAt: "" } : {}),
  });

  store.recordContentSelection(file.id, queue, req.params.id, false);
  store.addActivity(`Selected Dropbox image for ${queue === "pinterest" ? "Pinterest" : "IG Spam"}: "${file.name.slice(0, 100)}"`);
  res.json(updated);
});

// Sends one approved Pinterest queue item to the private Zapier Catch Hook.
// A successful response means Zapier accepted the job; it does not yet prove
// Pinterest completed the downstream Create Pin action, so the status becomes
// "submitted" rather than "posted".
app.post("/api/publish/pinterest/:id", async (req, res) => {
  if (!ZAPIER_PINTEREST_WEBHOOK_URL) {
    return res.status(503).json({ error: "Pinterest publishing is not configured yet." });
  }

  const item = store.getQueueItem("pinterest", req.params.id);
  if (!item) return res.status(404).json({ error: "Pinterest queue item not found" });
  if (["publishing", "submitted", "posted"].includes(item.status)) {
    return res.status(409).json({ error: `This Pin is already ${item.status} and will not be sent twice.`, item });
  }
  if (!item.url) return res.status(400).json({ error: "Add an image to this Pinterest slot before publishing." });

  let imageUrl = item.url;
  if (item.dropboxFileId) {
    const catalog = loadCatalog();
    const file = catalog.files[item.dropboxFileId];
    if (!file || !file.isImage) {
      return res.status(400).json({ error: "The selected Dropbox image is no longer available. Choose it again from the Content Library." });
    }
    try {
      imageUrl = await getTemporaryLink(file.path);
    } catch (err) {
      console.error("Dropbox temporary link failed during publish:", err);
      return res.status(502).json({ error: "Could not prepare the selected Dropbox image for publishing. Refresh the Content Library and try again." });
    }
  } else if (imageUrl.startsWith("/uploads/")) {
    const expires = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
    const sig = publishSignature("pinterest", item.id, expires);
    imageUrl = `${req.protocol}://${req.get("host")}/publish-media/pinterest/${encodeURIComponent(item.id)}?expires=${expires}&sig=${sig}`;
  } else if (!/^https:\/\//i.test(imageUrl)) {
    return res.status(400).json({ error: "This image source cannot be published yet." });
  }

  const payload = {
    queue_item_id: item.id,
    image_url: imageUrl,
    title: item.title || item.name || "Avere Forza",
    description: item.caption || "",
    destination_url: item.destinationUrl || "https://avereforza.com",
  };

  try {
    // Persist the lock before calling Zapier so a fast double-click or second
    // browser cannot enqueue the same Pin twice.
    store.updateQueueItem("pinterest", item.id, { status: "publishing" });

    const zap = await fetch(ZAPIER_PINTEREST_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const responseText = await zap.text();
    if (!zap.ok) throw new Error(`Zapier returned ${zap.status}: ${responseText.slice(0, 300)}`);

    const updated = store.updateQueueItem("pinterest", item.id, { status: "submitted" });
    store.addActivity(`Sent Pinterest slot to Zapier: "${(item.title || item.caption || item.name).slice(0, 80)}"`);
    return res.json({ success: true, status: "submitted", item: updated });
  } catch (err) {
    console.error("Pinterest publish failed:", err);
    store.updateQueueItem("pinterest", item.id, { status: "failed" });
    return res.status(502).json({ error: "Could not send this Pin to Zapier. Check the Zap and try again." });
  }
});

// Sends one IG Spam queue item to the private Zapier Catch Hook.
// As with Pinterest, Zapier acceptance is only an enqueue acknowledgement;
// the callback route above marks the item "posted" after Instagram succeeds.
app.post("/api/publish/instagram/:id", async (req, res) => {
  if (!ZAPIER_INSTAGRAM_WEBHOOK_URL) {
    return res.status(503).json({ error: "Instagram publishing is not configured yet." });
  }

  const item = store.getQueueItem("spam", req.params.id);
  if (!item) return res.status(404).json({ error: "IG Spam queue item not found" });
  if (["publishing", "submitted", "posted"].includes(item.status)) {
    return res.status(409).json({ error: `This Instagram post is already ${item.status} and will not be sent twice.`, item });
  }
  if (!item.url) return res.status(400).json({ error: "Add an image to this IG Spam slot before publishing." });

  let imageUrl = item.url;
  if (item.dropboxFileId) {
    const catalog = loadCatalog();
    const file = catalog.files[item.dropboxFileId];
    if (!file || !file.isImage) {
      return res.status(400).json({ error: "The selected Dropbox image is no longer available. Choose it again from the Content Library." });
    }
    try {
      imageUrl = await getTemporaryLink(file.path);
    } catch (err) {
      console.error("Dropbox temporary link failed during publish:", err);
      return res.status(502).json({ error: "Could not prepare the selected Dropbox image for publishing. Refresh the Content Library and try again." });
    }
  } else if (imageUrl.startsWith("/uploads/")) {
    const expires = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
    const sig = publishSignature("spam", item.id, expires);
    imageUrl = `${req.protocol}://${req.get("host")}/publish-media/spam/${encodeURIComponent(item.id)}?expires=${expires}&sig=${sig}`;
  } else if (!/^https:\/\//i.test(imageUrl)) {
    return res.status(400).json({ error: "This image source cannot be published yet." });
  }

  const payload = {
    queue_item_id: item.id,
    image_url: imageUrl,
    caption: item.caption || "",
  };

  try {
    store.updateQueueItem("spam", item.id, { status: "publishing" });

    const zap = await fetch(ZAPIER_INSTAGRAM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const responseText = await zap.text();
    if (!zap.ok) throw new Error(`Zapier returned ${zap.status}: ${responseText.slice(0, 300)}`);

    const updated = store.updateQueueItem("spam", item.id, { status: "submitted" });
    store.addActivity(`Sent IG Spam slot to Zapier: "${(item.caption || item.name).slice(0, 80)}"`);
    return res.json({ success: true, status: "submitted", item: updated });
  } catch (err) {
    console.error("Instagram publish failed:", err);
    store.updateQueueItem("spam", item.id, { status: "failed" });
    return res.status(502).json({ error: "Could not send this Instagram post to Zapier. Check the Zap and try again." });
  }
});

app.post("/api/influencers", (req, res) => {
  res.status(201).json(store.createInfluencer(req.body));
});
app.put("/api/influencers/:id", (req, res) => {
  const updated = store.updateInfluencer(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Influencer not found" });
  res.json(updated);
});
app.delete("/api/influencers/:id", (req, res) => {
  store.deleteInfluencer(req.params.id);
  res.status(204).end();
});

app.post("/api/ideas", (req, res) => {
  res.status(201).json(store.createIdea(req.body));
});
app.delete("/api/ideas/:id", (req, res) => {
  store.deleteIdea(req.params.id);
  res.status(204).end();
});

app.post("/api/activity", (req, res) => {
  store.addActivity(req.body.text || "");
  res.status(201).json(store.getFullState().activity);
});

app.post("/api/reset", (req, res) => {
  store.resetAll();
  res.json(store.getFullState());
});

/* =========================================================
   DROPBOX CONTENT LIBRARY — read-only.
========================================================= */
function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(DROPBOX_CATALOG_FILE, "utf8"));
  } catch {
    return { rootPath: CONTENT_FOLDER, cursor: null, files: {}, lastSyncedAt: null };
  }
}
function saveCatalog(catalog) {
  fs.writeFileSync(DROPBOX_CATALOG_FILE, JSON.stringify(catalog, null, 2));
}
function classify(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return { ext: ext.toUpperCase(), isImage: IMAGE_EXT.includes(ext), isVideo: VIDEO_EXT.includes(ext) };
}

function normaliseDropboxPath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return raw || "/";
}

function folderInfo(filePath) {
  const root = normaliseDropboxPath(CONTENT_FOLDER);
  const full = normaliseDropboxPath(filePath);
  let relative = full;
  if (full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    relative = full.slice(root.length + 1);
  } else {
    relative = full.replace(/^\/+/, "");
  }
  const parts = relative.split("/").filter(Boolean);
  parts.pop(); // filename
  const relativeFolder = parts.length ? parts.join("/") : "Root";
  return {
    relativeFolder,
    topFolder: parts.length ? parts[0] : "Root",
  };
}


/* =========================================================
   DAILY DROPBOX AUTO-FILL
   Chooses eligible Dropbox images for Pinterest / IG Spam queue
   slots, but never publishes them. Every generated slot remains
   awaiting approval until the user explicitly presses Publish.
========================================================= */
const AUTO_FILL_QUEUES = new Set(["pinterest", "spam"]);
const LONDON_TZ = "Europe/London";

function londonClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
function londonDate() { return londonClockParts().date; }

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function fileMatchesFolders(file, folders) {
  if (!Array.isArray(folders) || folders.length === 0) return true;
  const info = folderInfo(file.path);
  const relative = String(info.relativeFolder || "Root").toLowerCase();
  const top = String(info.topFolder || "Root").toLowerCase();
  return folders.some(value => {
    const wanted = String(value || "").replace(/^\/+|\/+$/g, "").toLowerCase();
    return wanted === "root" ? relative === "root"
      : top === wanted || relative === wanted || relative.startsWith(`${wanted}/`);
  });
}

function eligibleDropboxImages(catalog, queue, config, excludeItemId = "", extraExcluded = new Set()) {
  const recent = store.getRecentUsedFileIds(queue, config.noRepeatDays);
  const queued = store.getCurrentlyQueuedDropboxIds(excludeItemId);
  const blocked = new Set([...recent, ...queued, ...extraExcluded]);
  return Object.values(catalog.files || {}).filter(file =>
    file.isImage && fileMatchesFolders(file, config.sourceFolders) && !blocked.has(file.id)
  );
}

function assignAutoFile(queue, item, file, today) {
  const previewUrl = `/api/dropbox-thumbnail?id=${encodeURIComponent(file.id)}`;
  const resetFields = queue === "pinterest"
    ? { pinterestPinId: "", pinterestPinUrl: "", publishedAt: "" }
    : { instagramMediaId: "", instagramPermalink: "", publishedAt: "" };
  const updated = store.updateQueueItem(queue, item.id, {
    image_url: previewUrl,
    dropboxFileId: file.id,
    name: file.name,
    title: "",
    caption: "",
    destinationUrl: "",
    status: "awaiting_approval",
    assignedDate: today,
    autoSelected: true,
    ...resetFields,
  });
  store.recordContentSelection(file.id, queue, item.id, true);
  return updated;
}

async function runAutoFill(queue, { force = false, initiatedBy = "manual" } = {}) {
  if (!AUTO_FILL_QUEUES.has(queue)) throw new Error("Auto-fill is only available for Pinterest and IG Spam.");
  const allSettings = store.getAutoFillSettings();
  const config = allSettings[queue];
  const today = londonDate();
  if (!force && config.lastRunDate === today) {
    return { skipped: true, reason: "already_filled_today", queue, settings: config, items: store.getQueueItems(queue) };
  }

  const { catalog } = await syncCatalog();
  const queueItems = store.getQueueItems(queue).slice(0, config.slots);
  const protectedStatuses = new Set(["publishing", "submitted"]);
  // Snapshot everything assigned before the run too, so replacing old slots
  // cannot make yesterday's asset immediately eligible for a later slot.
  const selectedThisRun = store.getCurrentlyQueuedDropboxIds("");
  const assigned = [];
  const skipped = [];

  for (const item of queueItems) {
    if (protectedStatuses.has(item.status)) {
      skipped.push({ id: item.id, reason: item.status });
      continue;
    }
    if (item.status === "posted" && item.assignedDate === today) {
      skipped.push({ id: item.id, reason: "posted_today" });
      continue;
    }
    if (!force && item.assignedDate === today && item.url) {
      skipped.push({ id: item.id, reason: "already_filled_today" });
      continue;
    }

    const extraExcluded = new Set(selectedThisRun);
    if (item.dropboxFileId) extraExcluded.add(item.dropboxFileId);
    const candidates = eligibleDropboxImages(catalog, queue, config, item.id, extraExcluded);
    if (!candidates.length) {
      skipped.push({ id: item.id, reason: "no_eligible_media" });
      continue;
    }
    const file = shuffle(candidates)[0];
    selectedThisRun.add(file.id);
    assigned.push(assignAutoFile(queue, item, file, today));
  }

  // A manual run counts as today's fill too, preventing the scheduler from
  // immediately replacing suggestions later the same day.
  store.setAutoFillLastRun(queue, today);
  const label = queue === "pinterest" ? "Pinterest" : "IG Spam";
  store.addActivity(`${label} auto-fill ${initiatedBy === "schedule" ? "ran" : "generated"}: ${assigned.length} suggestion${assigned.length === 1 ? "" : "s"}`);
  return { success: true, queue, date: today, assigned, skipped, settings: store.getAutoFillSettings()[queue], items: store.getQueueItems(queue) };
}

async function replaceAutoSuggestion(queue, itemId) {
  if (!AUTO_FILL_QUEUES.has(queue)) throw new Error("Auto-fill replacement is only available for Pinterest and IG Spam.");
  const item = store.getQueueItem(queue, itemId);
  if (!item) throw new Error("Queue item not found.");
  if (["publishing", "submitted", "posted"].includes(item.status)) throw new Error("This slot can no longer be replaced.");

  const config = store.getAutoFillSettings()[queue];
  const { catalog } = await syncCatalog();
  const extra = new Set(item.dropboxFileId ? [item.dropboxFileId] : []);
  let candidates = eligibleDropboxImages(catalog, queue, config, item.id, extra);
  if (!candidates.length) throw new Error("No other eligible Dropbox images match this queue's current rules.");
  const file = shuffle(candidates)[0];
  const updated = assignAutoFile(queue, item, file, londonDate());
  const label = queue === "pinterest" ? "Pinterest" : "IG Spam";
  store.addActivity(`Replaced ${label} auto-fill suggestion: "${file.name.slice(0, 100)}"`);
  return updated;
}

// Pulls everything that changed since the last stored cursor and folds it
// into the persisted catalog, keyed by Dropbox's own file ID. Keying by ID
// is what prevents duplicates on repeated refreshes and lets us tell which
// files are genuinely new since the previous sync.
async function syncCatalog() {
  let catalog = loadCatalog();
  const currentRoot = normaliseDropboxPath(CONTENT_FOLDER);
  const catalogRoot = normaliseDropboxPath(catalog.rootPath || "");

  // Dropbox cursors are tied to the original list_folder root. If the HQ
  // content root changes (for example from /AVERE CONTENT/AF LIBRARY to
  // /AVERE CONTENT), discard the old cursor/catalog and do one clean scan.
  if (catalogRoot.toLowerCase() !== currentRoot.toLowerCase()) {
    catalog = { rootPath: currentRoot, cursor: null, files: {}, lastSyncedAt: null };
  } else {
    catalog.rootPath = currentRoot;
  }

  const knownIdsBefore = new Set(Object.keys(catalog.files));

  let cursor = catalog.cursor;
  let hasMore = true;
  let firstPage = !cursor;

  while (hasMore) {
    const page = firstPage ? await listFolder(CONTENT_FOLDER, null) : await listFolder(CONTENT_FOLDER, cursor);
    firstPage = false;

    for (const entry of page.entries) {
      if (entry[".tag"] === "file") {
        const { ext, isImage, isVideo } = classify(entry.name);
        catalog.files[entry.id] = {
          id: entry.id,
          name: entry.name,
          ext,
          path: entry.path_display || entry.path_lower,
          modified: entry.server_modified,
          size: entry.size,
          isImage,
          isVideo,
        };
      } else if (entry[".tag"] === "deleted") {
        const existing = Object.values(catalog.files).find(f => f.path === entry.path_display);
        if (existing) delete catalog.files[existing.id];
      }
    }

    cursor = page.cursor;
    hasMore = page.has_more;
  }

  catalog.cursor = cursor;
  catalog.lastSyncedAt = new Date().toISOString();
  saveCatalog(catalog);

  const newIds = Object.keys(catalog.files).filter(id => !knownIdsBefore.has(id));
  return { catalog, newIds };
}

// Auto-fill settings and actions. These routes only assign Dropbox file
// references to queue slots. They never publish and never write to Dropbox.
app.get("/api/autofill/settings", (req, res) => {
  res.json({ settings: store.getAutoFillSettings() });
});

app.put("/api/autofill/settings", (req, res) => {
  res.json({ settings: store.saveAutoFillSettings(req.body || {}) });
});

app.post("/api/autofill/:queue/run", async (req, res) => {
  try {
    const result = await runAutoFill(req.params.queue, { force: true, initiatedBy: "manual" });
    res.json(result);
  } catch (err) {
    console.error("Manual auto-fill failed:", err);
    res.status(400).json({ error: err.message || "Could not auto-fill this queue." });
  }
});

app.post("/api/autofill/:queue/:id/replace", async (req, res) => {
  try {
    res.json(await replaceAutoSuggestion(req.params.queue, req.params.id));
  } catch (err) {
    console.error("Auto-fill replacement failed:", err);
    res.status(400).json({ error: err.message || "Could not replace this suggestion." });
  }
});

// READ-ONLY: lists whatever is currently in the Dropbox content folder.
// Never renames, moves, uploads, edits, or deletes anything in Dropbox.
app.get("/api/dropbox-content", async (req, res) => {
  try {
    const { catalog, newIds } = await syncCatalog();
    const files = Object.values(catalog.files)
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
      .map(f => ({
        ...f,
        ...folderInfo(f.path),
        isNew: newIds.includes(f.id),
        thumbnailUrl: f.isImage ? `/api/dropbox-thumbnail?id=${encodeURIComponent(f.id)}` : null,
        openUrl: `/api/dropbox-open?id=${encodeURIComponent(f.id)}`,
      }));
    res.json({
      files,
      contentRoot: CONTENT_FOLDER,
      lastSyncedAt: catalog.lastSyncedAt,
      newCount: newIds.length,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not reach Dropbox. Check server credentials and try again." });
  }
});

// Streams a small read-only thumbnail. No Dropbox token or link is ever
// sent to the browser — only our own JPEG bytes, proxied through this route.
app.get("/api/dropbox-thumbnail", async (req, res) => {
  try {
    const catalog = loadCatalog();
    const file = catalog.files[req.query.id];
    if (!file) return res.status(404).end();
    const buffer = await getThumbnail(file.path);
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(502).end();
  }
});

// Generates a fresh, short-lived Dropbox link on demand and redirects to it.
// Used for "open/preview" on videos and full-size images. Nothing is stored
// or reused — a new link is minted for every request.
app.get("/api/dropbox-open", async (req, res) => {
  try {
    const catalog = loadCatalog();
    const file = catalog.files[req.query.id];
    if (!file) return res.status(404).end();
    const link = await getTemporaryLink(file.path);
    res.redirect(link);
  } catch (err) {
    console.error(err);
    res.status(502).end();
  }
});

// Turns upload/file-filter errors (e.g. a non-image file, an oversized file)
// into a clean JSON response instead of a crash or a hanging request.
app.use((err, req, res, next) => {
  if (err) {
    console.error(err);
    return res.status(400).json({ error: err.message || "Request failed." });
  }
  next();
});

// Lightweight daily scheduler. Render Starter stays running, so a minute-level
// check is enough; lastRunDate in SQLite prevents duplicate fills after restarts.
let autoFillTickRunning = false;
async function autoFillSchedulerTick() {
  if (autoFillTickRunning) return;
  autoFillTickRunning = true;
  try {
    const clock = londonClockParts();
    const settings = store.getAutoFillSettings();
    for (const queue of ["pinterest", "spam"]) {
      const cfg = settings[queue];
      if (!cfg.enabled || cfg.lastRunDate === clock.date || clock.time < cfg.fillTime) continue;
      try {
        await runAutoFill(queue, { force: false, initiatedBy: "schedule" });
      } catch (err) {
        console.error(`Scheduled ${queue} auto-fill failed:`, err);
      }
    }
  } finally {
    autoFillTickRunning = false;
  }
}
setTimeout(autoFillSchedulerTick, 10_000);
setInterval(autoFillSchedulerTick, 60_000);

// Bind explicitly to 0.0.0.0 so the app is reachable inside a container
// (Render, Docker, etc.), not just on localhost.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Avere Forza HQ server running on port ${PORT} (data dir: ${DATA_DIR})`);
});
