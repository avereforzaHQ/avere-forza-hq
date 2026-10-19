/* =========================================================
   AVERE FORZA HQ — main script
   Plain vanilla JS. No frameworks, no build step.

   DATA MODEL
   Dropbox (via /api/dropbox-*) is a separate, READ-ONLY source
   used only for media files in the Content Library — nothing
   here ever writes back to Dropbox.

   Everything else — queues, captions, statuses, approvals,
   ideas, influencers, and the activity log — is fully editable
   and lives in a real database on the server (see server/lib/db.js),
   reached through the /api/... endpoints below. That's what makes
   this survive a page reload, a different device, or a redeploy —
   nothing important is stored only in this browser tab.

   SECURITY NOTES
   - Every value that ultimately came from a person (a caption, an
     idea, an influencer's name/notes, a Dropbox filename, an
     activity log line) is passed through escapeHtml() before it's
     placed into innerHTML, so a stored value can never turn into
     executable HTML/JavaScript.
   - Any API call that comes back with 401 (session expired or not
     logged in) sends the browser to the login page — this is
     centralised in apiGet/apiSend/apiUpload/fetchDropboxContent so
     every part of the dashboard behaves the same way.
========================================================= */

/* ---------------------- helpers ---------------------- */
const qs  = (sel, el = document) => el.querySelector(sel);
const qsa = (sel, el = document) => [...el.querySelectorAll(sel)];

function nowStr() {
  return new Date().toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

// Escapes a value for safe placement inside innerHTML — turns any stored
// caption/idea/influencer detail/filename/activity line into inert text
// instead of markup the browser would parse and run.
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(msg, type = "default") {
  const box = qs("#toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg; // toasts use textContent already, so no escaping needed here
  box.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

/* ---------------------- API layer ----------------------
   Every HQ data change goes through the server. If the server
   can't be reached, we tell the user plainly instead of quietly
   pretending it saved. Any 401 response (no session / expired
   session) sends the browser to the login page, consistently,
   from every call site below — including Dropbox refresh and
   photo uploads.
--------------------------------------------------------- */
function redirectToLogin() {
  window.location.href = "/login.html";
}

async function apiGet(url) {
  const res = await fetch(url);
  if (res.status === 401) { redirectToLogin(); throw new Error("Not authenticated"); }
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}
async function apiSend(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { redirectToLogin(); throw new Error("Not authenticated"); }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}
async function apiUpload(url, file, fieldName) {
  const form = new FormData();
  form.append(fieldName, file);
  const res = await fetch(url, { method: "POST", body: form });
  if (res.status === 401) { redirectToLogin(); throw new Error("Not authenticated"); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `UPLOAD ${url} -> ${res.status}`);
  }
  return res.json();
}

/* ---------------------- state (mirrors the server) ---------------------- */
const state = {
  folders: { pinterest: [], spam: [], personal: [] }, // local-only "not yet uploaded" staging, cleared on refresh
  queues: { pinterest: [], spam: [], personal: [] },
  influencers: [],
  ideas: [],
  activity: [],
  dropboxLibrary: [],
  dropboxLastSync: "Not synced yet",
};

async function logActivity(text) {
  try {
    state.activity = await apiSend("/api/activity", "POST", { text });
  } catch {
    state.activity.unshift({ text, time: nowStr() }); // still show it locally even if the save failed
  }
  renderActivity();
  renderStats();
}

/* ---------------------- navigation ---------------------- */
const views = qsa(".view");
const navButtons = qsa(".nav-btn");
const viewTitle = qs("#view-title");
const sidebar = qs("#sidebar");
const overlay = qs("#overlay");

navButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.view;
    navButtons.forEach(b => b.classList.toggle("active", b === btn));
    views.forEach(v => v.classList.toggle("active", v.id === `view-${target}`));
    viewTitle.textContent = btn.textContent.trim();
    closeSidebar();
  });
});

qs("#hamburger").addEventListener("click", () => {
  sidebar.classList.add("open");
  overlay.classList.add("active");
});
function closeSidebar() {
  sidebar.classList.remove("open");
  overlay.classList.remove("active");
}
overlay.addEventListener("click", closeSidebar);

qs("#topbar-date").textContent = new Date().toLocaleDateString(undefined, {
  weekday: "long", year: "numeric", month: "long", day: "numeric"
});

/* ---------------------- PHOTO QUEUES ---------------------- */
const QUEUE_CONFIG = {
  pinterest: { container: "#pinterest-cards", platform: "Pinterest", times: 3 },
  spam:      { container: "#spam-cards",      platform: "IG Spam account", times: 3 },
  personal:  { container: "#personal-pending-cards", platform: "Instagram Reels + YouTube Shorts", times: 1 },
};

function renderQueue(key) {
  const cfg = QUEUE_CONFIG[key];
  const container = qs(cfg.container);
  if (!container) return;
  const visible = key === "personal" ? state.queues[key].filter(i => i.status === "pending") : state.queues[key];

  container.innerHTML = "";
  visible.forEach(item => {
    const card = document.createElement("div");
    card.className = "post-card";

    const safeName = escapeHtml(item.name);
    const thumb = item.url
      ? `<img class="thumb" src="${escapeHtml(item.url)}" alt="${safeName}" />`
      : `<div class="thumb-placeholder">📷<br>${safeName}<br><span style="font-size:11px">(click Swap to add a real photo)</span></div>`;

    card.innerHTML = `
      ${thumb}
      <div class="post-card-body">
        ${key === "pinterest" ? `<input class="queue-text-input" type="text" placeholder="Pinterest title" data-role="title" value="${escapeHtml(item.title ?? "")}" />` : ""}
        <textarea placeholder="${key === "pinterest" ? "Pinterest description..." : "Write a caption..."}" data-role="caption">${escapeHtml(item.caption ?? "")}</textarea>
        ${key === "pinterest" ? `<input class="queue-text-input" type="url" placeholder="Destination link (optional)" data-role="destination-url" value="${escapeHtml(item.destinationUrl ?? "")}" />` : ""}
        <div class="post-card-meta">
          <span>${safeName}${item.dropboxFileId ? ` <span class="source-badge">Dropbox</span>` : ""}</span>
          <span class="status-pill status-${escapeHtml(item.status || "pending")}">${escapeHtml(item.status)}</span>
        </div>
        ${key === "pinterest" && item.pinterestPinUrl ? `<a class="view-pin-link" href="${escapeHtml(item.pinterestPinUrl)}" target="_blank" rel="noopener noreferrer">View Pin ↗</a>` : ""}
        ${key === "spam" && item.instagramPermalink ? `<a class="view-pin-link" href="${escapeHtml(item.instagramPermalink)}" target="_blank" rel="noopener noreferrer">View Post ↗</a>` : ""}
        <div class="card-actions">
          ${["pinterest", "spam"].includes(key) ? `<button class="btn-secondary" type="button" data-role="dropbox">Choose from Dropbox</button>` : ""}
          <label class="btn-secondary" style="cursor:pointer;">
            Upload from Mac
            <input type="file" accept="image/*" data-role="swap" />
          </label>
          <button class="btn-primary" data-role="post" ${["posted","submitted","publishing"].includes(item.status) ? "disabled" : ""}>
            ${key === "pinterest"
              ? (item.status === "posted" ? "Posted" : item.status === "submitted" ? "Sent to Zapier" : item.status === "publishing" ? "Publishing…" : "Publish Pin")
              : key === "spam"
                ? (item.status === "posted" ? "Posted" : item.status === "submitted" ? "Sent to Zapier" : item.status === "publishing" ? "Publishing…" : "Publish Post")
                : "Approve & schedule"}
          </button>
        </div>
      </div>
    `;

    if (key === "pinterest") {
      let titleTimer = null;
      card.querySelector('[data-role="title"]')?.addEventListener("input", e => {
        item.title = e.target.value;
        clearTimeout(titleTimer);
        titleTimer = setTimeout(() => apiSend(`/api/queues/${key}/${item.id}`, "PATCH", { title: item.title })
          .catch(() => toast("Couldn't save that title", "error")), 500);
      });

      let linkTimer = null;
      card.querySelector('[data-role="destination-url"]')?.addEventListener("input", e => {
        item.destinationUrl = e.target.value;
        clearTimeout(linkTimer);
        linkTimer = setTimeout(() => apiSend(`/api/queues/${key}/${item.id}`, "PATCH", { destinationUrl: item.destinationUrl })
          .catch(() => toast("Couldn't save that link", "error")), 500);
      });
    }

    // caption editing — saved to the server as you type (debounced)
    let captionTimer = null;
    card.querySelector('[data-role="caption"]').addEventListener("input", e => {
      item.caption = e.target.value;
      clearTimeout(captionTimer);
      captionTimer = setTimeout(async () => {
        try {
          await apiSend(`/api/queues/${key}/${item.id}`, "PATCH", { caption: item.caption });
        } catch {
          toast("Couldn't save that caption — check the server is running", "error");
        }
      }, 500);
    });

    // choose a media asset directly from the read-only Dropbox Content Library.
    // This stores only a reference in the HQ database; Dropbox itself is never changed.
    card.querySelector('[data-role="dropbox"]')?.addEventListener("click", () => {
      openDropboxPicker(key, item.id);
    });

    // swap photo — uploaded to the server so it persists across reloads/devices
    card.querySelector('[data-role="swap"]').addEventListener("change", async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const updated = await apiUpload(`/api/queues/${key}/${item.id}/photo`, file, "photo");
        item.url = updated.url;
        item.name = updated.name;
        renderQueue(key);
        toast(`Photo swapped for ${cfg.platform}`, "success");
      } catch (err) {
        toast(err.message || "Couldn't upload that photo — check the server is running", "error");
      }
    });

    // post / approve
    card.querySelector('[data-role="post"]').addEventListener("click", async () => {
      if (key === "pinterest") {
        if (!item.url) { toast("Add an image to this Pinterest slot first", "error"); return; }
        try {
          item.status = "publishing";
          renderQueue(key);
          const result = await postToPinterest(item.id);
          item.status = result.item?.status || result.status || "submitted";
          toast("Pin sent to Zapier", "success");

          // Zapier calls the HQ back after Pinterest actually creates the Pin.
          // Poll briefly so the card can move from submitted -> posted and show
          // the live Pinterest link without requiring a manual page refresh.
          if (item.status === "submitted") {
            const confirmed = await waitForPinterestCompletion(item.id);
            if (confirmed) {
              Object.assign(item, confirmed);
              if (item.status === "posted") toast("Pin posted on Pinterest", "success");
            }
          }
        } catch (err) {
          item.status = "failed";
          toast(err.message || "Couldn't send this Pin to Zapier", "error");
        }
        renderQueue(key);
        renderStats();
        return;
      }

      if (key === "spam") {
        if (!item.url) { toast("Add an image to this IG Spam slot first", "error"); return; }
        try {
          item.status = "publishing";
          renderQueue(key);
          const result = await postToInstagramSpam(item.id);
          item.status = result.item?.status || result.status || "submitted";
          toast("Instagram post sent to Zapier", "success");

          if (item.status === "submitted") {
            const confirmed = await waitForInstagramCompletion(item.id);
            if (confirmed) {
              Object.assign(item, confirmed);
              if (item.status === "posted") toast("Instagram post is live", "success");
            }
          }
        } catch (err) {
          item.status = "failed";
          toast(err.message || "Couldn't send this Instagram post to Zapier", "error");
        }
        renderQueue(key);
        renderStats();
        return;
      }

      try {
        const updated = await apiSend(`/api/queues/${key}/${item.id}`, "PATCH", { status: "posted" });
        item.status = updated.status;
      } catch {
        toast("Couldn't save that — check the server is running", "error");
        return;
      }
      if (key === "personal") {
        await logActivity(`Approved for Reels + Shorts: "${(item.caption || item.name).slice(0, 60)}"`);
        renderPersonalApproved();
      } else {
        await logActivity(`Confirmed a ${cfg.platform} slot: "${(item.caption || item.name).slice(0, 60)}"`);
      }
      renderQueue(key);
      renderStats();
      renderPlan();
    });

    container.appendChild(card);
  });

  if (visible.length === 0) {
    container.innerHTML = `<p class="empty-note">Nothing queued right now.</p>`;
  }
}

function renderPersonalApproved() {
  const list = qs("#personal-approved-list");
  const approved = state.queues.personal.filter(i => i.status === "posted");
  list.innerHTML = "";
  if (approved.length === 0) {
    list.innerHTML = `<li class="empty-note" style="background:none;">Nothing approved yet.</li>`;
    return;
  }
  approved.forEach(item => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(item.caption || item.name)}</span><span class="tag">Reels + Shorts</span>`;
    list.appendChild(li);
  });
}

/* ---------------------- FOLDER UPLOADS (Settings) ----------------------
   These stay as a quick local staging area for photos you haven't assigned
   to a specific queue slot yet. To actually get a photo into a queue slot,
   use "Swap photo" on that slot's card — that's what saves to the server.
------------------------------------------------------------------------- */
function wireFolderUpload(inputId, folderKey, countId) {
  qs(inputId).addEventListener("change", e => {
    const files = [...e.target.files];
    files.forEach(file => {
      state.folders[folderKey].push({ url: URL.createObjectURL(file), name: file.name });
    });
    qs(countId).textContent = `${state.folders[folderKey].length} photos staged`;
    toast(`${files.length} photo(s) staged for ${folderKey} — use "Swap photo" on a slot to save one`, "success");
  });
}
wireFolderUpload("#upload-pinterest", "pinterest", "#count-pinterest");
wireFolderUpload("#upload-spam", "spam", "#count-spam");
wireFolderUpload("#upload-personal", "personal", "#count-personal");

/* ---------------------- DROPBOX QUEUE PICKER ----------------------
   Lets an exact Pinterest or IG Spam slot choose an existing image from
   the live Dropbox Content Library. The file stays in Dropbox; the HQ
   stores only its Dropbox file ID and uses a fresh temporary read-only
   link later when publishing through Zapier.
--------------------------------------------------------------------- */
let dropboxPickerTarget = null;
let dropboxPickerFilters = { search: "", folder: "", type: "all" };

function ensureDropboxPicker() {
  let backdrop = qs("#dropbox-picker-backdrop");
  if (backdrop) return backdrop;

  backdrop = document.createElement("div");
  backdrop.id = "dropbox-picker-backdrop";
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal dropbox-picker-modal" role="dialog" aria-modal="true" aria-labelledby="dropbox-picker-title">
      <div class="dropbox-picker-heading">
        <div>
          <h3 id="dropbox-picker-title">Choose from Dropbox</h3>
          <p class="subtext">Browse media from /AVERE CONTENT. Dropbox stays read-only.</p>
        </div>
        <button class="btn-ghost" type="button" data-role="close-picker">Close</button>
      </div>
      <div class="dropbox-picker-controls">
        <input class="dropbox-picker-search" type="search" placeholder="Search file or folder names…" data-role="picker-search" />
        <select class="dropbox-picker-select" data-role="picker-folder" aria-label="Filter Dropbox folder">
          <option value="">All folders</option>
        </select>
        <select class="dropbox-picker-select" data-role="picker-type" aria-label="Filter media type">
          <option value="all">All media</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
      </div>
      <div class="dropbox-picker-summary" data-role="picker-summary"></div>
      <div class="dropbox-picker-grid" data-role="picker-grid"></div>
      <p class="dropbox-picker-note">Videos are available to browse and preview. Pinterest and IG photo queue selection remains image-only until video/Reels publishing is enabled.</p>
    </div>
  `;
  document.body.appendChild(backdrop);

  backdrop.querySelector('[data-role="close-picker"]').addEventListener("click", closeDropboxPicker);
  backdrop.addEventListener("click", e => {
    if (e.target === backdrop) closeDropboxPicker();
  });
  backdrop.querySelector('[data-role="picker-search"]').addEventListener("input", e => {
    dropboxPickerFilters.search = e.target.value;
    renderDropboxPickerAssets();
  });
  backdrop.querySelector('[data-role="picker-folder"]').addEventListener("change", e => {
    dropboxPickerFilters.folder = e.target.value;
    renderDropboxPickerAssets();
  });
  backdrop.querySelector('[data-role="picker-type"]').addEventListener("change", e => {
    dropboxPickerFilters.type = e.target.value;
    renderDropboxPickerAssets();
  });
  return backdrop;
}

function closeDropboxPicker() {
  const backdrop = qs("#dropbox-picker-backdrop");
  backdrop?.classList.remove("active");
  dropboxPickerTarget = null;
}

function populateDropboxPickerFolders() {
  const backdrop = ensureDropboxPicker();
  const select = backdrop.querySelector('[data-role="picker-folder"]');
  const folders = [...new Set(
    state.dropboxLibrary
      .filter(file => file.isImage || file.isVideo)
      .map(file => file.relativeFolder || "Root")
  )].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const current = dropboxPickerFilters.folder;
  select.innerHTML = `<option value="">All folders</option>` + folders.map(folder =>
    `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`
  ).join("");
  if (folders.includes(current)) select.value = current;
  else dropboxPickerFilters.folder = "";
}

function renderDropboxPickerAssets() {
  const backdrop = ensureDropboxPicker();
  const grid = backdrop.querySelector('[data-role="picker-grid"]');
  const summary = backdrop.querySelector('[data-role="picker-summary"]');
  const query = String(dropboxPickerFilters.search || "").trim().toLowerCase();

  const files = state.dropboxLibrary.filter(file => {
    if (!file.isImage && !file.isVideo) return false;
    const haystack = `${file.name || ""} ${file.relativeFolder || ""} ${file.path || ""}`.toLowerCase();
    const matchesSearch = !query || haystack.includes(query);
    const matchesFolder = !dropboxPickerFilters.folder || (file.relativeFolder || "Root") === dropboxPickerFilters.folder;
    const matchesType = dropboxPickerFilters.type === "all"
      || (dropboxPickerFilters.type === "image" && file.isImage)
      || (dropboxPickerFilters.type === "video" && file.isVideo);
    return matchesSearch && matchesFolder && matchesType;
  });

  const imageCount = files.filter(file => file.isImage).length;
  const videoCount = files.filter(file => file.isVideo).length;
  summary.textContent = `${files.length} item${files.length === 1 ? "" : "s"} · ${imageCount} image${imageCount === 1 ? "" : "s"} · ${videoCount} video${videoCount === 1 ? "" : "s"}`;

  if (!files.length) {
    grid.innerHTML = `<p class="empty-note">No matching media found in /AVERE CONTENT.</p>`;
    return;
  }

  grid.innerHTML = files.map(file => {
    const folder = file.relativeFolder || "Root";
    if (file.isVideo) {
      return `
        <a class="dropbox-picker-item dropbox-picker-video" href="${escapeHtml(file.openUrl || "#")}" target="_blank" rel="noopener" title="Preview ${escapeHtml(file.name)}">
          <div class="dropbox-picker-placeholder"><span class="dropbox-video-icon">▶</span><strong>${escapeHtml(file.ext || "VIDEO")}</strong></div>
          <span class="dropbox-picker-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="dropbox-picker-folder" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
          <span class="dropbox-picker-action">Preview video ↗</span>
        </a>
      `;
    }
    return `
      <button class="dropbox-picker-item" type="button" data-file-id="${escapeHtml(file.id)}">
        ${file.thumbnailUrl
          ? `<img src="${escapeHtml(file.thumbnailUrl)}" alt="${escapeHtml(file.name)}" />`
          : `<div class="dropbox-picker-placeholder">${escapeHtml(file.ext || "IMG")}</div>`}
        <span class="dropbox-picker-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        <span class="dropbox-picker-folder" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
        <span class="dropbox-picker-action">Use image</span>
      </button>
    `;
  }).join("");

  grid.querySelectorAll("[data-file-id]").forEach(button => {
    button.addEventListener("click", async () => {
      if (!dropboxPickerTarget) return;
      const { queueKey, itemId } = dropboxPickerTarget;
      const fileId = button.dataset.fileId;
      button.disabled = true;
      try {
        const updated = await apiSend(`/api/queues/${queueKey}/${encodeURIComponent(itemId)}/dropbox`, "POST", { fileId });
        const item = state.queues[queueKey].find(entry => String(entry.id) === String(itemId));
        if (item) Object.assign(item, updated);
        closeDropboxPicker();
        renderQueue(queueKey);
        renderStats();
        toast(`Selected ${updated.name} from Dropbox`, "success");
      } catch (err) {
        button.disabled = false;
        toast(err.message || "Couldn't use that Dropbox image", "error");
      }
    });
  });
}

async function openDropboxPicker(queueKey, itemId) {
  if (!["pinterest", "spam"].includes(queueKey)) return;
  const backdrop = ensureDropboxPicker();
  const queueName = queueKey === "pinterest" ? "Pinterest" : "IG Spam";
  const item = state.queues[queueKey].find(entry => String(entry.id) === String(itemId));
  backdrop.querySelector("#dropbox-picker-title").textContent = `Choose Dropbox media — ${queueName}${item?.name ? ` · ${item.name}` : ""}`;
  dropboxPickerFilters = { search: "", folder: "", type: "all" };
  backdrop.querySelector('[data-role="picker-search"]').value = "";
  backdrop.querySelector('[data-role="picker-type"]').value = "all";
  backdrop.querySelector('[data-role="picker-grid"]').innerHTML = `<p class="empty-note">Refreshing Dropbox library…</p>`;
  dropboxPickerTarget = { queueKey, itemId };
  backdrop.classList.add("active");

  await refreshDropboxLibrary({ silent: true });
  if (!dropboxPickerTarget) return;
  populateDropboxPickerFolders();
  backdrop.querySelector('[data-role="picker-folder"]').value = "";
  renderDropboxPickerAssets();
}

/* ---------------------- DROPBOX CONTENT LIBRARY ----------------------
   Read-only — Dropbox is the source of truth for media, on purpose kept
   separate from the database that stores everything else in this file.
------------------------------------------------------------------------ */
function renderDropboxLibrary() {
  const tbody = qs("#dropbox-tbody");
  if (!tbody) return;

  if (!state.dropboxLibrary.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-note">No files found yet — click Refresh.</td></tr>`;
  } else {
    tbody.innerHTML = state.dropboxLibrary.map(file => {
      const safeName = escapeHtml(file.name);
      const safeExt = escapeHtml(file.ext);
      const thumb = file.thumbnailUrl
        ? `<img src="${escapeHtml(file.thumbnailUrl)}" alt="${safeName}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;" />`
        : `<span class="pill">${safeExt}</span>`;
      const modified = file.modified
        ? new Date(file.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : "—";
      const newBadge = file.isNew ? ` <span class="pill" style="color:var(--success);">NEW</span>` : "";
      const openLink = file.openUrl
        ? `<a href="${escapeHtml(file.openUrl)}" target="_blank" rel="noopener">${file.isVideo ? "Preview video" : "Open full size"}</a>`
        : "—";
      return `
        <tr>
          <td>${thumb}</td>
          <td>${safeName}${newBadge}</td>
          <td>${escapeHtml(file.relativeFolder || "Root")}</td>
          <td><span class="pill">${safeExt}</span></td>
          <td>${escapeHtml(modified)}</td>
          <td>${openLink}</td>
        </tr>
      `;
    }).join("");
  }

  const syncLabel = qs("#dropbox-last-refresh");
  if (syncLabel) syncLabel.textContent = `Last synced: ${state.dropboxLastSync}`;
}

async function refreshDropboxLibrary({ silent = false } = {}) {
  if (!silent) toast("Asking Dropbox for the latest files...", "default");
  try {
    const data = await fetchDropboxContent();
    state.dropboxLibrary = data.files;
    state.dropboxLastSync = data.lastSyncedAt
      ? new Date(data.lastSyncedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : nowStr();
    renderDropboxLibrary();
    if (!silent) {
      const newsBit = data.newCount > 0 ? `, ${data.newCount} new` : "";
      logActivity(`Refreshed Dropbox content library (${data.files.length} files${newsBit})`);
      toast(data.newCount > 0 ? `${data.newCount} new file(s) found` : "Content library is up to date", "success");
    }
  } catch (err) {
    renderDropboxLibrary();
    if (!silent) toast("Couldn't reach the Dropbox server — check the backend is running", "error");
  }
}

qs("#refresh-dropbox-btn")?.addEventListener("click", () => refreshDropboxLibrary());

/* ---------------------- VIDEO IDEAS ---------------------- */
function renderIdeas() {
  const list = qs("#idea-list");
  list.innerHTML = "";
  if (state.ideas.length === 0) {
    list.innerHTML = `<li class="empty-note" style="background:none;">No ideas yet — add one above.</li>`;
    return;
  }
  state.ideas.forEach(idea => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="idea-text">${escapeHtml(idea.text)}</span>
      <span class="idea-tag">${escapeHtml(idea.tag)}</span>
      <button data-id="${escapeHtml(idea.id)}" title="Delete">✕</button>
    `;
    li.querySelector("button").addEventListener("click", async () => {
      try {
        await apiSend(`/api/ideas/${idea.id}`, "DELETE");
        state.ideas = state.ideas.filter(i => i.id !== idea.id);
        renderIdeas();
        renderStats();
      } catch {
        toast("Couldn't delete that idea — check the server is running", "error");
      }
    });
    list.appendChild(li);
  });
}

qs("#idea-form").addEventListener("submit", async e => {
  e.preventDefault();
  const input = qs("#idea-input");
  const tag = qs("#idea-tag").value;
  if (!input.value.trim()) return;
  try {
    const created = await apiSend("/api/ideas", "POST", { text: input.value.trim(), tag });
    state.ideas.unshift(created);
    input.value = "";
    renderIdeas();
    renderStats();
    toast("Idea saved", "success");
  } catch {
    toast("Couldn't save that idea — check the server is running", "error");
  }
});

/* ---------------------- INFLUENCER DATABASE ---------------------- */
const modalBackdrop = qs("#influencer-modal-backdrop");
const influencerForm = qs("#influencer-form");

function openInfluencerModal(influencer = null) {
  qs("#influencer-modal-title").textContent = influencer ? "Edit creator" : "Add creator";
  qs("#influencer-id").value = influencer?.id ?? "";
  qs("#f-name").value = influencer?.name ?? "";
  qs("#f-email").value = influencer?.email ?? "";
  qs("#f-size").value = influencer?.size ?? "M";
  qs("#f-color").value = influencer?.color ?? "";
  qs("#f-address").value = influencer?.address ?? "";
  qs("#f-status").value = influencer?.status ?? "Not sent";
  qs("#f-notes").value = influencer?.notes ?? "";
  modalBackdrop.classList.add("active");
}
function closeInfluencerModal() { modalBackdrop.classList.remove("active"); }

qs("#add-influencer-btn").addEventListener("click", () => openInfluencerModal());
qs("#influencer-cancel").addEventListener("click", closeInfluencerModal);
modalBackdrop.addEventListener("click", e => { if (e.target === modalBackdrop) closeInfluencerModal(); });

influencerForm.addEventListener("submit", async e => {
  e.preventDefault();
  const id = qs("#influencer-id").value;
  const record = {
    name: qs("#f-name").value.trim(),
    email: qs("#f-email").value.trim(),
    size: qs("#f-size").value,
    color: qs("#f-color").value.trim(),
    address: qs("#f-address").value.trim(),
    status: qs("#f-status").value,
    notes: qs("#f-notes").value.trim(),
  };
  try {
    if (id) {
      const updated = await apiSend(`/api/influencers/${id}`, "PUT", record);
      state.influencers = state.influencers.map(i => i.id === id ? updated : i);
      toast("Creator updated", "success");
    } else {
      const created = await apiSend("/api/influencers", "POST", record);
      state.influencers.push(created);
      toast("Creator added", "success");
    }
    closeInfluencerModal();
    renderInfluencerFilters();
    renderInfluencerTable();
    renderStats();
  } catch {
    toast("Couldn't save that creator — check the server is running", "error");
  }
});

function renderInfluencerFilters() {
  const sizeSel = qs("#filter-size");
  const colorSel = qs("#filter-color");
  const statusSel = qs("#filter-status");
  const keep = (sel) => sel.value;
  const prevSize = keep(sizeSel), prevColor = keep(colorSel), prevStatus = keep(statusSel);

  const sizes = [...new Set(state.influencers.map(i => i.size).filter(Boolean))];
  const colors = [...new Set(state.influencers.map(i => i.color).filter(Boolean))];
  const statuses = [...new Set(state.influencers.map(i => i.status).filter(Boolean))];

  sizeSel.innerHTML = `<option value="">All sizes</option>` + sizes.map(s => `<option>${escapeHtml(s)}</option>`).join("");
  colorSel.innerHTML = `<option value="">All colours</option>` + colors.map(c => `<option>${escapeHtml(c)}</option>`).join("");
  statusSel.innerHTML = `<option value="">All statuses</option>` + statuses.map(s => `<option>${escapeHtml(s)}</option>`).join("");

  sizeSel.value = sizes.includes(prevSize) ? prevSize : "";
  colorSel.value = colors.includes(prevColor) ? prevColor : "";
  statusSel.value = statuses.includes(prevStatus) ? prevStatus : "";
}

function renderInfluencerTable() {
  const tbody = qs("#influencer-tbody");
  const emptyState = qs("#influencer-empty");
  const search = qs("#influencer-search").value.toLowerCase().trim();
  const sizeF = qs("#filter-size").value;
  const colorF = qs("#filter-color").value;
  const statusF = qs("#filter-status").value;

  const rows = state.influencers.filter(i => {
    const matchesSearch = !search || i.name.toLowerCase().includes(search) || i.email.toLowerCase().includes(search);
    const matchesSize = !sizeF || i.size === sizeF;
    const matchesColor = !colorF || i.color === colorF;
    const matchesStatus = !statusF || i.status === statusF;
    return matchesSearch && matchesSize && matchesColor && matchesStatus;
  });

  tbody.innerHTML = "";
  rows.forEach(i => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(i.name)}</td>
      <td><span class="pill">${escapeHtml(i.size) || "—"}</span></td>
      <td>${escapeHtml(i.color) || "—"}</td>
      <td>${escapeHtml(i.email) || "—"}</td>
      <td>${escapeHtml(i.address) || "—"}</td>
      <td><span class="pill">${escapeHtml(i.status)}</span></td>
      <td class="row-actions">
        <button data-action="edit" title="Edit">✎</button>
        <button data-action="delete" title="Delete">✕</button>
      </td>
    `;
    tr.querySelector('[data-action="edit"]').addEventListener("click", () => openInfluencerModal(i));
    tr.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`Remove ${i.name} from the database?`)) return;
      try {
        await apiSend(`/api/influencers/${i.id}`, "DELETE");
        state.influencers = state.influencers.filter(x => x.id !== i.id);
        renderInfluencerFilters();
        renderInfluencerTable();
        renderStats();
      } catch {
        toast("Couldn't delete that creator — check the server is running", "error");
      }
    });
    tbody.appendChild(tr);
  });

  emptyState.style.display = rows.length ? "none" : "block";
  if (state.influencers.length && !rows.length) {
    emptyState.textContent = "No creators match your filters.";
  } else {
    emptyState.textContent = 'No creators yet — click "Add creator" to start your database.';
  }
}

["#influencer-search", "#filter-size", "#filter-color", "#filter-status"].forEach(sel => {
  qs(sel).addEventListener("input", renderInfluencerTable);
});

qs("#export-csv-btn").addEventListener("click", () => {
  if (!state.influencers.length) { toast("No creators to export yet", "error"); return; }
  const header = ["Name", "Email", "Size", "Colour", "Address", "Status", "Notes"];
  const rows = state.influencers.map(i => [i.name, i.email, i.size, i.color, i.address, i.status, i.notes]);
  const csv = [header, ...rows]
    .map(r => r.map(cell => `"${(cell || "").toString().replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "avere-forza-influencers.csv";
  a.click();
  toast("CSV exported", "success");
});

/* ---------------------- SETTINGS: connections ---------------------- */
const PLATFORMS = [
  { name: "Instagram", key: "instagram" },
  { name: "TikTok", key: "tiktok" },
  { name: "YouTube Shorts", key: "youtube" },
  { name: "Pinterest", key: "pinterest" },
];
function renderConnections() {
  const grid = qs("#connection-grid");
  grid.innerHTML = PLATFORMS.map(p => `
    <div class="connection-card">
      <span class="conn-name">${escapeHtml(p.name)}</span>
      <span class="conn-status">Not connected</span>
      <button class="btn-secondary" data-platform="${escapeHtml(p.key)}">Connect</button>
    </div>
  `).join("");
  qsa("[data-platform]", grid).forEach(btn => {
    btn.addEventListener("click", () => {
      toast("This needs a backend service with real API keys — see README.md", "error");
    });
  });
}

qs("#logout-btn")?.addEventListener("click", async () => {
  try {
    await apiSend("/api/logout", "POST");
  } catch {
    // even if the request fails, still send the user to the login page
  }
  redirectToLogin();
});

qs("#reset-data-btn").addEventListener("click", async () => {
  if (!confirm("This clears every queue, idea and influencer stored on the server. Continue?")) return;
  try {
    const fresh = await apiSend("/api/reset", "POST");
    state.queues = fresh.queues;
    state.influencers = fresh.influencers;
    state.ideas = fresh.ideas;
    state.activity = fresh.activity;
    renderEverythingExceptDropbox();
    toast("HQ data reset", "success");
  } catch {
    toast("Couldn't reset — check the server is running", "error");
  }
});

/* ---------------------- DASHBOARD ---------------------- */
function renderStats() {
  const postedCount = key => state.queues[key].filter(i => i.status === "posted").length;
  const pinterestDone = state.queues.pinterest.filter(i => ["submitted","posted"].includes(i.status)).length;
  qs("#stat-pinterest").textContent = `${pinterestDone}/3`;
  qs("#stat-spam").textContent = `${postedCount("spam")}/3`;
  qs("#stat-personal").textContent = state.queues.personal.filter(i => i.status === "pending").length;
  qs("#stat-influencers").textContent = state.influencers.length;
  qs("#stat-ideas").textContent = state.ideas.length;
}

function renderPlan() {
  const plan = [
    { time: "09:00", text: "Pinterest slot 1", tag: "Pinterest" },
    { time: "13:00", text: "Pinterest slot 2", tag: "Pinterest" },
    { time: "18:00", text: "Pinterest slot 3", tag: "Pinterest" },
    { time: "10:00", text: "IG Spam post 1", tag: "IG Spam" },
    { time: "15:00", text: "IG Spam post 2", tag: "IG Spam" },
    { time: "20:00", text: "IG Spam post 3", tag: "IG Spam" },
    { time: "On approval", text: "Personal Reel / Short", tag: "Personal" },
  ];
  const list = qs("#plan-list");
  list.innerHTML = plan.map(p => `<li><span>${p.text}</span><span class="tag">${p.time}</span></li>`).join("");
}

function renderActivity() {
  const list = qs("#activity-log");
  if (!state.activity.length) {
    list.innerHTML = `<li class="empty-note" style="background:none;">Nothing logged yet.</li>`;
    return;
  }
  list.innerHTML = state.activity
    .map(a => `<li><span>${escapeHtml(a.text)}</span><span class="time">${escapeHtml(a.time)}</span></li>`)
    .join("");
}

/* =========================================================
   BACKEND HOOKS
   The Dropbox Content Library and the HQ database are both
   wired to the real backend in /server. Pinterest and IG Spam
   publish through secure Zapier-backed server endpoints.
   postToInstagramReelsAndShorts remains a stand-in until video publishing is built —
   that will run through its own Zapier-based integration, kept
   separate from both Dropbox and the HQ database.
========================================================= */
async function postToPinterest(queueItemId) {
  return apiSend(`/api/publish/pinterest/${encodeURIComponent(queueItemId)}`, "POST", {});
}

async function waitForPinterestCompletion(queueItemId, attempts = 12, delayMs = 2500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      const latest = await apiGet("/api/state");
      const item = latest.queues?.pinterest?.find(entry => String(entry.id) === String(queueItemId));
      if (item && ["posted", "failed"].includes(item.status)) return item;
    } catch (err) {
      if (String(err?.message || "").includes("Not authenticated")) throw err;
    }
  }
  return null;
}

async function postToInstagramSpam(queueItemId) {
  return apiSend(`/api/publish/instagram/${encodeURIComponent(queueItemId)}`, "POST", {});
}

async function waitForInstagramCompletion(queueItemId, attempts = 12, delayMs = 2500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      const latest = await apiGet("/api/state");
      const item = latest.queues?.spam?.find(entry => String(entry.id) === String(queueItemId));
      if (item && ["posted", "failed"].includes(item.status)) return item;
    } catch (err) {
      if (String(err?.message || "").includes("Not authenticated")) throw err;
    }
  }
  return null;
}
async function postToInstagramReelsAndShorts(videoUrl, caption) {
  console.log("[stub] would post to IG Reels + YouTube Shorts:", caption);
}

// Real call to our own secure backend — never talks to Dropbox directly,
// never sees a Dropbox token. Read-only: the server only ever lists files.
// Redirects to the login page on a 401, same as every other API call here.
async function fetchDropboxContent() {
  const res = await fetch("/api/dropbox-content");
  if (res.status === 401) { redirectToLogin(); throw new Error("Not authenticated"); }
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return res.json(); // { files: [...], lastSyncedAt, newCount }
}

/* ---------------------- INIT ---------------------- */
function renderEverythingExceptDropbox() {
  renderQueue("pinterest");
  renderQueue("spam");
  renderQueue("personal");
  renderPersonalApproved();
  renderIdeas();
  renderInfluencerFilters();
  renderInfluencerTable();
  renderStats();
  renderPlan();
  renderActivity();
}

async function init() {
  renderConnections();
  renderDropboxLibrary(); // empty state immediately, then fill in below
  try {
    const data = await apiGet("/api/state");
    state.queues = data.queues;
    state.influencers = data.influencers;
    state.ideas = data.ideas;
    state.activity = data.activity;
  } catch {
    toast("Couldn't reach the HQ server — start it with 'npm start' in the server folder", "error");
  }
  renderEverythingExceptDropbox();
  refreshDropboxLibrary({ silent: true });
}
init();
