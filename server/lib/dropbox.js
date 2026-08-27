/* =========================================================
   lib/dropbox.js
   Small helper around Dropbox's HTTP API. Read-only calls only:
   list_folder / list_folder/continue, get_thumbnail_v2, and
   get_temporary_link. Nothing here renames, moves, uploads,
   edits, or deletes anything in Dropbox.

   Auth: uses a long-lived refresh token (stored as an env var)
   to mint short-lived access tokens on demand. The refresh token
   and app secret never leave this server.
========================================================= */

const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_API = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT_API = "https://content.dropboxapi.com/2";

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
    client_id: process.env.DROPBOX_APP_KEY,
    client_secret: process.env.DROPBOX_APP_SECRET,
  });

  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dropbox token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = now + data.expires_in * 1000;
  return cachedAccessToken;
}

async function dropboxApiCall(endpoint, body) {
  const token = await getAccessToken();
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dropbox API ${endpoint} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Read-only folder listing. Pass a stored cursor to fetch only what changed
// since the last call (Dropbox's own delta-sync mechanism) — this is what
// lets the server detect new files cheaply instead of re-scanning everything.
async function listFolder(path, cursor) {
  if (cursor) {
    return dropboxApiCall("/files/list_folder/continue", { cursor });
  }
  return dropboxApiCall("/files/list_folder", {
    path,
    recursive: true,
    include_media_info: true,
  });
}

// Generates a short-lived (a few hours), read-only streaming link on demand.
// Nothing is persisted on Dropbox's side and no token is embedded in it that
// grants write access — safe to hand to the browser for "open/preview".
async function getTemporaryLink(path) {
  const data = await dropboxApiCall("/files/get_temporary_link", { path });
  return data.link;
}

// Streams a small JPEG thumbnail for an image file. Read-only.
async function getThumbnail(path, size = "w256h256") {
  const token = await getAccessToken();
  const res = await fetch(`${DROPBOX_CONTENT_API}/files/get_thumbnail_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        resource: { ".tag": "path", path },
        format: { ".tag": "jpeg" },
        size: { ".tag": size },
        mode: { ".tag": "strict" },
      }),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dropbox thumbnail failed: ${res.status} ${text}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

module.exports = { listFolder, getTemporaryLink, getThumbnail };
