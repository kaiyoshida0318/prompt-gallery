/* ==============================================================
   Prompt Gallery — Frontend app
   GitHub REST API を使って data.json と images/ を直接 commit する
   ============================================================== */

const STORAGE_KEY = "promptGallery.auth.v1";
const DATA_PATH = "data.json";
const IMAGES_DIR = "images";

let auth = null;        // { owner, repo, branch, token }
let dataSha = null;     // data.json の最新 SHA (更新時に必要)
let entries = [];       // 全エントリー
let activeTag = null;   // タグフィルタ
let currentDetailId = null;
let pendingImage = null; // { base64, mimeType, fileName }

// ---------- util ----------
const $ = (id) => document.getElementById(id);
const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
const b64decode = (str) => decodeURIComponent(escape(atob(str)));
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- GitHub API ----------
async function ghFetch(path, options = {}) {
  const url = `https://api.github.com/repos/${auth.owner}/${auth.repo}/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `token ${auth.token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API error: ${res.status}`);
  }
  return res;
}

async function loadData() {
  const res = await ghFetch(`contents/${DATA_PATH}?ref=${auth.branch}`);
  if (res.status === 404) {
    entries = [];
    dataSha = null;
    return;
  }
  const data = await res.json();
  dataSha = data.sha;
  try {
    const json = JSON.parse(b64decode(data.content.replace(/\n/g, "")));
    entries = Array.isArray(json.entries) ? json.entries : [];
  } catch (e) {
    console.error("data.json 解析失敗", e);
    entries = [];
  }
}

async function saveData(commitMessage) {
  const body = {
    message: commitMessage,
    content: b64encode(JSON.stringify({ entries }, null, 2)),
    branch: auth.branch
  };
  if (dataSha) body.sha = dataSha;
  const res = await ghFetch(`contents/${DATA_PATH}`, {
    method: "PUT",
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "data.json の保存に失敗");
  }
  const result = await res.json();
  dataSha = result.content.sha;
}

async function uploadImage(path, base64Content, commitMessage) {
  const res = await ghFetch(`contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: commitMessage,
      content: base64Content,
      branch: auth.branch
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "画像アップロードに失敗");
  }
}

async function deleteFile(path, sha, commitMessage) {
  // sha がない場合は取得
  if (!sha) {
    const info = await ghFetch(`contents/${path}?ref=${auth.branch}`);
    if (info.status === 404) return;
    const j = await info.json();
    sha = j.sha;
  }
  await ghFetch(`contents/${path}`, {
    method: "DELETE",
    body: JSON.stringify({ message: commitMessage, sha, branch: auth.branch })
  });
}

// 画像URL取得のキャッシュ(同じ画像を何度もAPIで取りにいかないため)
const imageCache = new Map();

// GitHub API経由で画像を取得してBlob URLを返す
// Privateリポジトリの画像を表示するには、PAT認証付きでAPIを叩く必要がある
async function fetchImageAsBlobUrl(path) {
  if (imageCache.has(path)) return imageCache.get(path);
  try {
    const res = await ghFetch(`contents/${path}?ref=${auth.branch}`);
    if (!res.ok) throw new Error(`画像取得失敗: ${path}`);
    const data = await res.json();
    // base64 → Blob に変換
    const binary = atob(data.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ext = (path.split(".").pop() || "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
               : ext === "gif" ? "image/gif"
               : ext === "webp" ? "image/webp"
               : "image/png";
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    imageCache.set(path, url);
    return url;
  } catch (e) {
    console.error("画像読み込み失敗", path, e);
    return "";
  }
}

// 非同期で画像を読み込んで<img>タグにセット
function loadImageInto(imgEl, path) {
  imgEl.dataset.loading = "1";
  fetchImageAsBlobUrl(path).then((url) => {
    if (url) imgEl.src = url;
    imgEl.removeAttribute("data-loading");
  });
}

// ---------- 認証 ----------
function loadAuth() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function saveAuth(a) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
}
function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

async function verifyAuth(a) {
  const res = await fetch(`https://api.github.com/repos/${a.owner}/${a.repo}`, {
    headers: { "Authorization": `token ${a.token}`, "Accept": "application/vnd.github+json" }
  });
  if (!res.ok) throw new Error("リポジトリにアクセスできません。ユーザー名・リポジトリ名・トークン権限をご確認ください。");
  return true;
}

// ---------- レンダリング ----------
function render() {
  const q = $("search-input").value.trim().toLowerCase();
  const filtered = entries.filter((e) => {
    if (activeTag && !(e.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    const hay = [e.prompt, e.negative, e.note, e.model, ...(e.tags || [])].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  $("stat-count").textContent = entries.length;

  const gallery = $("gallery");
  $("loading").style.display = "none";
  if (entries.length === 0) {
    $("empty-state").style.display = "block";
    gallery.innerHTML = "";
    renderTagFilters();
    return;
  }
  $("empty-state").style.display = "none";

  gallery.innerHTML = filtered.map((e) => `
    <div class="card" data-id="${e.id}">
      <div class="card-img"><img data-path="${escapeHtml(e.image)}" alt="" loading="lazy" /></div>
      <div class="card-body">
        <div class="card-prompt">${escapeHtml(e.prompt || "")}</div>
        <div class="card-meta">
          <span class="card-model">${escapeHtml(e.model || "—")}</span>
          <span>${fmtDate(e.createdAt)}</span>
        </div>
      </div>
    </div>
  `).join("");

  // 全ての画像を非同期で読み込む
  document.querySelectorAll(".card-img img[data-path]").forEach((img) => {
    loadImageInto(img, img.dataset.path);
  });

  document.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.id));
  });
  renderTagFilters();
}

function renderTagFilters() {
  const allTags = new Set();
  entries.forEach((e) => (e.tags || []).forEach((t) => allTags.add(t)));
  const sorted = [...allTags].sort();
  const wrap = $("tag-filters");
  wrap.innerHTML = sorted.map((t) =>
    `<span class="tag-chip ${activeTag === t ? "active" : ""}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`
  ).join("");
  wrap.querySelectorAll(".tag-chip").forEach((el) => {
    el.addEventListener("click", () => {
      activeTag = activeTag === el.dataset.tag ? null : el.dataset.tag;
      render();
    });
  });
}

// ---------- 詳細モーダル ----------
function closeAllModals() {
  ["add-modal", "edit-modal", "detail-modal"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

function openDetail(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  closeAllModals();
  currentDetailId = id;
  $("detail-img").src = "";
  loadImageInto($("detail-img"), e.image);
  $("detail-prompt").textContent = e.prompt || "";
  $("detail-model").textContent = e.model || "モデル未設定";
  $("detail-date").textContent = fmtDate(e.createdAt);

  if (e.negative) {
    $("negative-section").style.display = "block";
    $("detail-negative").textContent = e.negative;
  } else $("negative-section").style.display = "none";

  if (e.tags && e.tags.length) {
    $("tags-section").style.display = "block";
    $("detail-tags").innerHTML = e.tags.map((t) => `<span class="detail-tag">${escapeHtml(t)}</span>`).join("");
  } else $("tags-section").style.display = "none";

  if (e.note) {
    $("note-section").style.display = "block";
    $("detail-note").textContent = e.note;
  } else $("note-section").style.display = "none";

  $("detail-modal").style.display = "flex";
}

async function deleteEntry() {
  const e = entries.find((x) => x.id === currentDetailId);
  if (!e) return;
  if (!confirm("このエントリーを削除しますか? (画像ファイルも削除されます)")) return;
  try {
    // まず画像を削除
    await deleteFile(e.image, null, `Delete image: ${e.id}`);
    // 次にdata.jsonから削除
    entries = entries.filter((x) => x.id !== e.id);
    await saveData(`Delete entry: ${e.id}`);
    $("detail-modal").style.display = "none";
    render();
  } catch (err) {
    alert("削除に失敗しました: " + err.message);
  }
}

// ---------- 編集 ----------
function openEdit() {
  const e = entries.find((x) => x.id === currentDetailId);
  if (!e) return;
  // プレビュー画像(詳細モーダルのimgを流用して即時表示)
  $("edit-preview-img").src = "";
  loadImageInto($("edit-preview-img"), e.image);
  // 既存の値をフォームに読み込み
  $("edit-prompt").value = e.prompt || "";
  $("edit-negative").value = e.negative || "";
  $("edit-model").value = e.model || "";
  $("edit-tags").value = (e.tags || []).join(", ");
  $("edit-note").value = e.note || "";
  $("edit-status").textContent = "";
  $("edit-status").className = "save-status";
  // 詳細モーダルを閉じて編集モーダルを開く
  $("detail-modal").style.display = "none";
  $("edit-modal").style.display = "flex";
}

async function updateEntry() {
  const prompt = $("edit-prompt").value.trim();
  if (!prompt) {
    alert("Promptは必須です");
    return;
  }

  const btn = $("btn-update");
  btn.disabled = true;
  $("edit-status").textContent = "保存中…";
  $("edit-status").className = "save-status";

  try {
    // 最新を取得して競合回避
    await loadData();

    const idx = entries.findIndex((x) => x.id === currentDetailId);
    if (idx === -1) throw new Error("対象のエントリーが見つかりません");

    // 元の image, id, createdAt は保持して、他を更新
    entries[idx] = {
      ...entries[idx],
      prompt,
      negative: $("edit-negative").value.trim() || undefined,
      model: $("edit-model").value.trim() || undefined,
      tags: $("edit-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      note: $("edit-note").value.trim() || undefined,
      updatedAt: new Date().toISOString()
    };

    await saveData(`Update entry: ${currentDetailId}`);

    $("edit-status").textContent = "✓ 更新しました";
    $("edit-status").className = "save-status ok";
    setTimeout(() => {
      $("edit-modal").style.display = "none";
      render();
    }, 700);
  } catch (err) {
    $("edit-status").textContent = "✗ " + err.message;
    $("edit-status").className = "save-status err";
  } finally {
    btn.disabled = false;
  }
}

// ---------- 追加 ----------
function resetAddForm() {
  pendingImage = null;
  $("preview-wrap").style.display = "none";
  $("dropzone").style.display = "block";
  $("file-input").value = "";
  $("input-prompt").value = "";
  $("input-negative").value = "";
  $("input-model").value = "";
  $("input-tags").value = "";
  $("input-note").value = "";
  $("save-status").textContent = "";
  $("save-status").className = "save-status";
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("画像ファイルを選んでください");
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    const base64 = dataUrl.split(",")[1];
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    pendingImage = { base64, mimeType: file.type, ext };
    $("preview-img").src = dataUrl;
    $("preview-wrap").style.display = "block";
    $("dropzone").style.display = "none";
  };
  reader.readAsDataURL(file);
}

async function saveEntry() {
  const prompt = $("input-prompt").value.trim();
  if (!pendingImage) { alert("画像を選択してください"); return; }
  if (!prompt) { alert("Promptは必須です"); return; }

  const btn = $("btn-save");
  btn.disabled = true;
  $("save-status").textContent = "画像をアップロード中…";
  $("save-status").className = "save-status";

  try {
    const id = genId();
    const ext = pendingImage.ext;
    const imgPath = `${IMAGES_DIR}/${id}.${ext}`;
    await uploadImage(imgPath, pendingImage.base64, `Add image: ${id}`);

    $("save-status").textContent = "メタデータを保存中…";

    const entry = {
      id,
      image: imgPath,
      prompt,
      negative: $("input-negative").value.trim() || undefined,
      model: $("input-model").value.trim() || undefined,
      tags: $("input-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      note: $("input-note").value.trim() || undefined,
      createdAt: new Date().toISOString()
    };

    // 最新を取得して競合回避
    await loadData();
    entries.unshift(entry);
    await saveData(`Add entry: ${id}`);

    $("save-status").textContent = "✓ 保存しました";
    $("save-status").className = "save-status ok";
    setTimeout(() => {
      $("add-modal").style.display = "none";
      resetAddForm();
      render();
    }, 700);
  } catch (err) {
    $("save-status").textContent = "✗ " + err.message;
    $("save-status").className = "save-status err";
  } finally {
    btn.disabled = false;
  }
}

// ---------- コピー ----------
function copyText(text, btnEl) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btnEl.textContent;
    btnEl.textContent = "コピー済み";
    btnEl.classList.add("copied");
    setTimeout(() => {
      btnEl.textContent = orig;
      btnEl.classList.remove("copied");
    }, 1200);
  });
}

// ---------- イベント ----------
function bindEvents() {
  // 認証モーダル
  $("auth-save").addEventListener("click", async () => {
    const a = {
      owner: $("input-owner").value.trim(),
      repo: $("input-repo").value.trim(),
      branch: $("input-branch").value.trim() || "main",
      token: $("input-token").value.trim()
    };
    if (!a.owner || !a.repo || !a.token) {
      $("auth-error").textContent = "全ての項目を入力してください";
      return;
    }
    $("auth-error").textContent = "";
    $("auth-save").disabled = true;
    $("auth-save").textContent = "接続中…";
    try {
      await verifyAuth(a);
      saveAuth(a);
      auth = a;
      $("auth-modal").style.display = "none";
      await init();
    } catch (err) {
      $("auth-error").textContent = err.message;
    } finally {
      $("auth-save").disabled = false;
      $("auth-save").textContent = "接続する";
    }
  });

  // 設定ボタン
  $("btn-settings").addEventListener("click", () => {
    if (confirm("接続設定をリセットしますか? (トークン等をブラウザから削除)")) {
      clearAuth();
      location.reload();
    }
  });

  // 追加ボタン
  $("btn-add").addEventListener("click", () => {
    resetAddForm();
    $("add-modal").style.display = "flex";
  });

  // モーダル閉じる(×ボタン or キャンセルボタンのみ。背景クリックでは閉じない)
  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => {
      $(el.dataset.close).style.display = "none";
    });
  });

  // ドロップゾーン
  const dz = $("dropzone");
  dz.addEventListener("click", () => $("file-input").click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    handleFile(e.dataTransfer.files[0]);
  });
  $("file-input").addEventListener("change", (e) => handleFile(e.target.files[0]));
  $("preview-clear").addEventListener("click", () => {
    pendingImage = null;
    $("preview-wrap").style.display = "none";
    $("dropzone").style.display = "block";
    $("file-input").value = "";
  });

  // 保存
  $("btn-save").addEventListener("click", saveEntry);

  // 検索
  $("search-input").addEventListener("input", render);

  // コピー
  $("copy-prompt").addEventListener("click", (e) => copyText($("detail-prompt").textContent, e.target));
  $("copy-negative").addEventListener("click", (e) => copyText($("detail-negative").textContent, e.target));

  // 削除
  $("btn-delete").addEventListener("click", deleteEntry);

  // 編集
  $("btn-edit").addEventListener("click", openEdit);
  $("btn-update").addEventListener("click", updateEntry);

  // 画面外ドラッグ防止
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

// ---------- 初期化 ----------
async function init() {
  $("loading").style.display = "block";
  $("gallery").innerHTML = "";
  try {
    await loadData();
    render();
  } catch (err) {
    $("loading").textContent = "読み込み失敗: " + err.message;
  }
}

(function start() {
  bindEvents();
  closeAllModals(); // 念のため全モーダルを閉じた状態で起動
  auth = loadAuth();
  if (auth) {
    $("auth-modal").style.display = "none";
    init();
  } else {
    $("auth-modal").style.display = "flex";
  }
})();
