/* =========================================================
   server/lib/db.js
   A small real database (SQLite, stored in a single file on disk)
   for everything in the dashboard EXCEPT the Dropbox content
   library — queues, captions, statuses, approvals, ideas,
   influencers, and the activity log. This is what makes the HQ
   keep working, and keep being editable, after the browser tab
   is closed or the app is redeployed. Dropbox stays a separate,
   read-only source used only for media files.
========================================================= */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// All persistent files live under DATA_DIR (set to /var/data on Render's
// persistent disk in production; defaults to server/data for local runs).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "avereforza.db");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS queue_items (
    id TEXT PRIMARY KEY,
    queue TEXT NOT NULL,          -- 'pinterest' | 'spam' | 'personal'
    name TEXT NOT NULL,
    title TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    destination_url TEXT DEFAULT '',
    status TEXT DEFAULT 'pending', -- 'pending' | 'publishing' | 'submitted' | 'posted' | 'failed'
    image_url TEXT,
    dropbox_file_id TEXT DEFAULT '',
    pinterest_pin_id TEXT DEFAULT '',
    pinterest_pin_url TEXT DEFAULT '',
    instagram_media_id TEXT DEFAULT '',
    instagram_permalink TEXT DEFAULT '',
    published_at TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS influencers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    size TEXT DEFAULT '',
    color TEXT DEFAULT '',
    address TEXT DEFAULT '',
    status TEXT DEFAULT 'Not sent',
    notes TEXT DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    tag TEXT DEFAULT 'Other',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Lightweight schema migrations for existing Render databases.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('queue_items', 'title', "TEXT DEFAULT ''");
ensureColumn('queue_items', 'destination_url', "TEXT DEFAULT ''");
ensureColumn('queue_items', 'pinterest_pin_id', "TEXT DEFAULT ''");
ensureColumn('queue_items', 'pinterest_pin_url', "TEXT DEFAULT ''");
ensureColumn('queue_items', 'instagram_media_id', "TEXT DEFAULT ''");
ensureColumn('queue_items', 'instagram_permalink', "TEXT DEFAULT ''");
ensureColumn('queue_items', 'published_at', "TEXT DEFAULT ''");
ensureColumn('queue_items', 'dropbox_file_id', "TEXT DEFAULT ''");

function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function nowIso() {
  return new Date().toISOString();
}

// ---------- first-run seed data (only fires once, on an empty database) ----------
function seedIfEmpty() {
  const queueCount = db.prepare("SELECT COUNT(*) AS n FROM queue_items").get().n;
  if (queueCount === 0) {
    const insert = db.prepare(`
      INSERT INTO queue_items (id, queue, name, title, caption, destination_url, status, image_url, position, updated_at)
      VALUES (@id, @queue, @name, @title, @caption, @destination_url, @status, @image_url, @position, @updated_at)
    `);
    const seedQueue = (queue, prefix) => {
      for (let n = 1; n <= 3; n++) {
        insert.run({
          id: uid(), queue, name: `${prefix} placeholder ${n}`,
          title: "", caption: "", destination_url: "", status: "pending", image_url: null,
          position: n, updated_at: nowIso(),
        });
      }
    };
    seedQueue("pinterest", "Pinterest");
    seedQueue("spam", "Spam");
    seedQueue("personal", "Personal");
  }

  const influencerCount = db.prepare("SELECT COUNT(*) AS n FROM influencers").get().n;
  if (influencerCount === 0) {
    const insert = db.prepare(`
      INSERT INTO influencers (id, name, email, size, color, address, status, notes, updated_at)
      VALUES (@id, @name, @email, @size, @color, @address, @status, @notes, @updated_at)
    `);
    insert.run({
      id: uid(), name: "Ava Marsh", email: "ava.marsh@example.com",
      size: "M", color: "Black", address: "14 Rowan Street, Manchester, UK",
      status: "Shipped", notes: "Prefers reels over static posts.", updated_at: nowIso(),
    });
    insert.run({
      id: uid(), name: "Jordan Reyes", email: "jordan.r@example.com",
      size: "L", color: "Sage", address: "88 Palm Ave, Austin, TX, USA",
      status: "Not sent", notes: "", updated_at: nowIso(),
    });
  }

  const ideaCount = db.prepare("SELECT COUNT(*) AS n FROM ideas").get().n;
  if (ideaCount === 0) {
    db.prepare(`INSERT INTO ideas (id, text, tag, created_at) VALUES (?, ?, ?, ?)`)
      .run(uid(), "POV grid workout at golden hour", "Reel", nowIso());
  }

  const activityCount = db.prepare("SELECT COUNT(*) AS n FROM activity_log").get().n;
  if (activityCount === 0) {
    db.prepare(`INSERT INTO activity_log (text, created_at) VALUES (?, ?)`)
      .run("Workspace created", nowIso());
  }
}
seedIfEmpty();

// ---------- reads ----------
function getFullState() {
  const queues = { pinterest: [], spam: [], personal: [] };
  const rows = db.prepare(`SELECT * FROM queue_items ORDER BY queue, position, updated_at`).all();
  for (const row of rows) {
    if (queues[row.queue]) {
      queues[row.queue].push({
        id: row.id, name: row.name, title: row.title || "", caption: row.caption,
        destinationUrl: row.destination_url || "", status: row.status, url: row.image_url,
        dropboxFileId: row.dropbox_file_id || "",
        pinterestPinId: row.pinterest_pin_id || "", pinterestPinUrl: row.pinterest_pin_url || "",
        instagramMediaId: row.instagram_media_id || "", instagramPermalink: row.instagram_permalink || "",
        publishedAt: row.published_at || "",
      });
    }
  }

  const influencers = db.prepare(`SELECT * FROM influencers ORDER BY name`).all()
    .map(r => ({ id: r.id, name: r.name, email: r.email, size: r.size, color: r.color, address: r.address, status: r.status, notes: r.notes }));

  const ideas = db.prepare(`SELECT * FROM ideas ORDER BY created_at DESC`).all()
    .map(r => ({ id: r.id, text: r.text, tag: r.tag, date: r.created_at }));

  const activity = db.prepare(`SELECT * FROM activity_log ORDER BY id DESC LIMIT 30`).all()
    .map(r => ({ text: r.text, time: r.created_at }));

  return { queues, influencers, ideas, activity };
}

// ---------- queue items ----------
function updateQueueItem(queue, id, fields) {
  const current = db.prepare(`SELECT * FROM queue_items WHERE id = ? AND queue = ?`).get(id, queue);
  if (!current) return null;
  const next = {
    title: fields.title ?? current.title ?? "",
    caption: fields.caption ?? current.caption,
    destination_url: fields.destination_url ?? fields.destinationUrl ?? current.destination_url ?? "",
    status: fields.status ?? current.status,
    name: fields.name ?? current.name,
    image_url: fields.image_url ?? current.image_url,
    dropbox_file_id: fields.dropbox_file_id ?? fields.dropboxFileId ?? current.dropbox_file_id ?? "",
    pinterest_pin_id: fields.pinterest_pin_id ?? fields.pinterestPinId ?? current.pinterest_pin_id ?? "",
    pinterest_pin_url: fields.pinterest_pin_url ?? fields.pinterestPinUrl ?? current.pinterest_pin_url ?? "",
    instagram_media_id: fields.instagram_media_id ?? fields.instagramMediaId ?? current.instagram_media_id ?? "",
    instagram_permalink: fields.instagram_permalink ?? fields.instagramPermalink ?? current.instagram_permalink ?? "",
    published_at: fields.published_at ?? fields.publishedAt ?? current.published_at ?? "",
  };
  db.prepare(`
    UPDATE queue_items SET title = @title, caption = @caption, destination_url = @destination_url, status = @status, name = @name, image_url = @image_url, dropbox_file_id = @dropbox_file_id, pinterest_pin_id = @pinterest_pin_id, pinterest_pin_url = @pinterest_pin_url, instagram_media_id = @instagram_media_id, instagram_permalink = @instagram_permalink, published_at = @published_at, updated_at = @updated_at
    WHERE id = @id
  `).run({ ...next, updated_at: nowIso(), id });
  return { id, queue, title: next.title, caption: next.caption, destinationUrl: next.destination_url, status: next.status, name: next.name, image_url: next.image_url, url: next.image_url, dropboxFileId: next.dropbox_file_id, pinterestPinId: next.pinterest_pin_id, pinterestPinUrl: next.pinterest_pin_url, instagramMediaId: next.instagram_media_id, instagramPermalink: next.instagram_permalink, publishedAt: next.published_at };
}

function getQueueItem(queue, id) {
  const row = db.prepare(`SELECT * FROM queue_items WHERE id = ? AND queue = ?`).get(id, queue);
  if (!row) return null;
  return {
    id: row.id, queue: row.queue, name: row.name, title: row.title || "",
    caption: row.caption || "", destinationUrl: row.destination_url || "",
    status: row.status, url: row.image_url, image_url: row.image_url,
    dropboxFileId: row.dropbox_file_id || "",
    pinterestPinId: row.pinterest_pin_id || "", pinterestPinUrl: row.pinterest_pin_url || "",
    instagramMediaId: row.instagram_media_id || "", instagramPermalink: row.instagram_permalink || "",
    publishedAt: row.published_at || "",
  };
}

// ---------- influencers ----------
function createInfluencer(data) {
  const record = {
    id: uid(),
    name: data.name || "",
    email: data.email || "",
    size: data.size || "",
    color: data.color || "",
    address: data.address || "",
    status: data.status || "Not sent",
    notes: data.notes || "",
    updated_at: nowIso(),
  };
  db.prepare(`
    INSERT INTO influencers (id, name, email, size, color, address, status, notes, updated_at)
    VALUES (@id, @name, @email, @size, @color, @address, @status, @notes, @updated_at)
  `).run(record);
  delete record.updated_at;
  return record;
}

function updateInfluencer(id, data) {
  const current = db.prepare(`SELECT * FROM influencers WHERE id = ?`).get(id);
  if (!current) return null;
  const record = {
    id,
    name: data.name ?? current.name,
    email: data.email ?? current.email,
    size: data.size ?? current.size,
    color: data.color ?? current.color,
    address: data.address ?? current.address,
    status: data.status ?? current.status,
    notes: data.notes ?? current.notes,
    updated_at: nowIso(),
  };
  db.prepare(`
    UPDATE influencers SET name=@name, email=@email, size=@size, color=@color, address=@address, status=@status, notes=@notes, updated_at=@updated_at
    WHERE id=@id
  `).run(record);
  delete record.updated_at;
  return record;
}

function deleteInfluencer(id) {
  db.prepare(`DELETE FROM influencers WHERE id = ?`).run(id);
}

// ---------- ideas ----------
function createIdea(data) {
  const record = { id: uid(), text: data.text || "", tag: data.tag || "Other", created_at: nowIso() };
  db.prepare(`INSERT INTO ideas (id, text, tag, created_at) VALUES (@id, @text, @tag, @created_at)`).run(record);
  return { id: record.id, text: record.text, tag: record.tag, date: record.created_at };
}

function deleteIdea(id) {
  db.prepare(`DELETE FROM ideas WHERE id = ?`).run(id);
}

// ---------- activity ----------
function addActivity(text) {
  db.prepare(`INSERT INTO activity_log (text, created_at) VALUES (?, ?)`).run(text, nowIso());
  db.prepare(`
    DELETE FROM activity_log WHERE id NOT IN (
      SELECT id FROM activity_log ORDER BY id DESC LIMIT 30
    )
  `).run();
}

function resetAll() {
  db.exec(`DELETE FROM queue_items; DELETE FROM influencers; DELETE FROM ideas; DELETE FROM activity_log;`);
  seedIfEmpty();
}

module.exports = {
  getFullState,
  getQueueItem,
  updateQueueItem,
  createInfluencer,
  updateInfluencer,
  deleteInfluencer,
  createIdea,
  deleteIdea,
  addActivity,
  resetAll,
};
