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
let pendingSubImages = []; // 追加モーダル用サブ画像(保存前)
let editingSubImagesNew = []; // 編集モーダル:新規追加されたサブ画像
let editingSubImagesExisting = []; // 編集モーダル:既存のサブ画像path
let editingSubImagesRemoved = []; // 編集モーダル:削除予定の既存pathリスト

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
  // 404, 409, 422 は呼び出し元で個別に処理するため、ここでは例外にしない
  if (!res.ok && res.status !== 404 && res.status !== 409 && res.status !== 422) {
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

async function saveData(commitMessage, mergeFn) {
  // mergeFn: 競合時にどう entries をマージするかの関数 (oldEntries) => newEntries
  // 指定されない場合は現在の entries をそのまま使う(=最新を上書き)
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
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

    if (res.ok) {
      const result = await res.json();
      dataSha = result.content.sha;
      return;
    }

    // sha不一致による競合 (GitHub APIは409または422を返すことがある)
    const errBody = await res.json().catch(() => ({}));
    const isConflict = res.status === 409 || res.status === 422 ||
                       (errBody.message && /does not match|sha/i.test(errBody.message));

    if (isConflict) {
      console.warn(`競合検出 (attempt ${attempt + 1}/${MAX_RETRIES}) - 最新のdata.jsonを取得してリトライ`);
      // 自分の変更を一時保存
      const myEntries = entries.slice();
      // 最新を取得
      await loadData();
      // マージ:mergeFnがあれば呼ぶ。なければ自分の変更を最新にマージ
      if (mergeFn) {
        entries = mergeFn(entries);
      } else {
        // デフォルト:idベースでマージ。自分の変更を優先しつつ他の人の変更も保持
        const myMap = new Map(myEntries.map((e) => [e.id, e]));
        const merged = entries.filter((e) => !myMap.has(e.id));
        merged.push(...myEntries);
        merged.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        entries = merged;
      }
      continue;
    }

    // それ以外のエラーはスロー
    throw new Error(errBody.message || "data.json の保存に失敗");
  }

  throw new Error("data.json の保存が複数回競合しました。ページをリロードして再度お試しください。");
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
    // まず Contents API で取得を試みる
    const res = await ghFetch(`contents/${path}?ref=${auth.branch}`);
    if (!res.ok) throw new Error(`画像取得失敗: ${path}`);
    const data = await res.json();

    let cleanBase64;
    if (data.content && data.encoding === "base64") {
      // 1MB以下:Contents APIで取得できたbase64を使う
      cleanBase64 = data.content.replace(/\s/g, "");
    } else if (data.sha) {
      // 1MB超:Contents APIだとcontentが空(encoding:'none')
      // Git Blob APIに切り替えて取得(最大100MBまで対応)
      console.log(`大きいファイル(${data.size}bytes) - Git Blob APIで取得: ${path}`);
      const blobRes = await ghFetch(`git/blobs/${data.sha}`);
      if (!blobRes.ok) throw new Error(`Git Blob API失敗: ${path}`);
      const blobData = await blobRes.json();
      if (!blobData.content) throw new Error(`Git Blob APIでもcontentが空: ${path}`);
      cleanBase64 = blobData.content.replace(/\s/g, "");
    } else {
      throw new Error(`画像のcontentもshaも取得できず: ${path}`);
    }

    // base64 → Blob に変換
    const binary = atob(cleanBase64);
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
    const hay = [e.prompt, e.negative, e.note, e.model, e.category, ...(e.tags || [])].filter(Boolean).join(" ").toLowerCase();
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
          <span class="card-model">${escapeHtml(e.category || e.model || "—")}</span>
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

// 編集モーダル用:新規サブ画像を読み込み
function handleEditSubFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > 50 * 1024 * 1024) {
      alert(`${file.name} は大きすぎます(50MB超)。スキップします。`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(",")[1];
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      editingSubImagesNew.push({ base64, mimeType: file.type, ext, dataUrl });
      refreshEditSubPreview();
    };
    reader.readAsDataURL(file);
  }
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
  $("detail-date").textContent = fmtDate(e.createdAt);

  // カテゴリ(新)
  if (e.category) {
    $("detail-category").style.display = "inline-block";
    $("detail-category").textContent = e.category;
  } else $("detail-category").style.display = "none";

  // モデル(旧データ互換)
  if (e.model) {
    $("detail-model").style.display = "inline-block";
    $("detail-model").textContent = e.model;
  } else $("detail-model").style.display = "none";

  // サブ画像(新)
  if (e.subImages && e.subImages.length) {
    $("sub-images-section").style.display = "block";
    $("detail-sub-images").innerHTML = e.subImages.map((path) =>
      `<img data-load-path="${escapeHtml(path)}" data-full-path="${escapeHtml(path)}" alt="" />`
    ).join("");
    $("detail-sub-images").querySelectorAll("img[data-load-path]").forEach((img) => {
      loadImageInto(img, img.dataset.loadPath);
      img.addEventListener("click", () => {
        // クリックで新タブで開く(Blob URL)
        if (img.src) window.open(img.src);
      });
    });
  } else $("sub-images-section").style.display = "none";

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
    // メイン画像を削除
    await deleteFile(e.image, null, `Delete image: ${e.id}`);
    // サブ画像も削除(失敗しても続行)
    for (const subPath of (e.subImages || [])) {
      try {
        await deleteFile(subPath, null, `Delete sub-image: ${e.id}`);
      } catch (err) {
        console.warn("サブ画像削除失敗(続行):", subPath, err);
      }
    }
    // data.jsonから削除
    entries = entries.filter((x) => x.id !== e.id);
    await saveData(`Delete entry: ${e.id}`, (latestEntries) => {
      return latestEntries.filter((x) => x.id !== e.id);
    });
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
  $("edit-category").value = e.category || "";
  $("edit-status").textContent = "";
  $("edit-status").className = "save-status";

  // サブ画像の状態を初期化
  editingSubImagesNew = [];
  editingSubImagesExisting = (e.subImages || []).slice();
  editingSubImagesRemoved = [];
  refreshEditSubPreview();

  $("edit-sub-file-input").value = "";
  // 詳細モーダルを閉じて編集モーダルを開く
  $("detail-modal").style.display = "none";
  $("edit-modal").style.display = "flex";
}

// 編集モーダルのサブ画像プレビュー全体を再描画
function refreshEditSubPreview() {
  const list = $("edit-sub-preview-list");
  const existingHtml = editingSubImagesExisting.map((path, i) => `
    <div class="sub-preview-item" data-kind="existing" data-index="${i}">
      <img data-load-path="${escapeHtml(path)}" alt="" />
      <button class="sub-preview-remove" data-kind="existing" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  const newHtml = editingSubImagesNew.map((item, i) => `
    <div class="sub-preview-item" data-kind="new" data-index="${i}">
      <img src="${item.dataUrl}" alt="" />
      <button class="sub-preview-remove" data-kind="new" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  list.innerHTML = existingHtml + newHtml;

  // 既存画像の読み込み
  list.querySelectorAll("img[data-load-path]").forEach((img) => {
    loadImageInto(img, img.dataset.loadPath);
  });
  // 削除ボタン
  list.querySelectorAll(".sub-preview-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      if (btn.dataset.kind === "existing") {
        // 既存画像を削除予定リストに入れて、リストから外す
        editingSubImagesRemoved.push(editingSubImagesExisting[idx]);
        editingSubImagesExisting.splice(idx, 1);
      } else {
        editingSubImagesNew.splice(idx, 1);
      }
      refreshEditSubPreview();
    });
  });
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
    const idx = entries.findIndex((x) => x.id === currentDetailId);
    if (idx === -1) throw new Error("対象のエントリーが見つかりません");
    const entryId = entries[idx].id;

    // 新規サブ画像をアップロード
    const newSubPaths = [];
    const existingCount = editingSubImagesExisting.length;
    for (let i = 0; i < editingSubImagesNew.length; i++) {
      $("edit-status").textContent = `サブ画像をアップロード中… (${i + 1}/${editingSubImagesNew.length})`;
      const sub = editingSubImagesNew[i];
      // 既存と衝突しないようにタイムスタンプを付ける
      const subPath = `${IMAGES_DIR}/${entryId}-sub-${Date.now()}-${existingCount + i + 1}.${sub.ext}`;
      await uploadImage(subPath, sub.base64, `Add sub-image: ${entryId}`);
      newSubPaths.push(subPath);
    }

    // 削除予定の既存サブ画像を削除
    for (const path of editingSubImagesRemoved) {
      try {
        await deleteFile(path, null, `Delete sub-image: ${entryId}`);
      } catch (e) {
        console.warn("サブ画像削除失敗(続行):", path, e);
      }
    }

    $("edit-status").textContent = "保存中…";

    // 最終的なサブ画像リスト
    const finalSubImages = [...editingSubImagesExisting, ...newSubPaths];

    // 元の image, id, createdAt は保持して、他を更新
    // negative, model, tags, note は既存の値があれば保持(今UIでは編集不可だが保存しておく)
    const updated = {
      ...entries[idx],
      prompt,
      category: $("edit-category").value.trim() || undefined,
      subImages: finalSubImages.length ? finalSubImages : undefined,
      updatedAt: new Date().toISOString()
    };
    entries[idx] = updated;

    // 競合時のマージ処理:最新entriesの中で同じidを更新版に置き換え
    await saveData(`Update entry: ${currentDetailId}`, (latestEntries) => {
      return latestEntries.map((e) => e.id === updated.id ? updated : e);
    });

    $("edit-status").textContent = "✓ 更新しました";
    $("edit-status").className = "save-status ok";
    setTimeout(() => {
      $("edit-modal").style.display = "none";
      editingSubImagesNew = [];
      editingSubImagesExisting = [];
      editingSubImagesRemoved = [];
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
  pendingSubImages = [];
  $("preview-wrap").style.display = "none";
  $("dropzone").style.display = "block";
  $("file-input").value = "";
  $("sub-file-input").value = "";
  $("sub-preview-list").innerHTML = "";
  $("input-prompt").value = "";
  $("input-category").value = "";
  $("save-status").textContent = "";
  $("save-status").className = "save-status";
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("画像ファイルを選んでください");
    return;
  }
  // GitHubの上限は100MBだが、APIで安定して扱えるのは50MB程度まで
  if (file.size > 50 * 1024 * 1024) {
    alert("画像が大きすぎます(50MB超)。サイズを小さくしてください。");
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

// ---------- サブ画像 ----------
function handleSubFiles(files, targetListId, pendingArray) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > 50 * 1024 * 1024) {
      alert(`${file.name} は大きすぎます(50MB超)。スキップします。`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(",")[1];
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const item = { base64, mimeType: file.type, ext, dataUrl, tempId: genId() };
      pendingArray.push(item);
      renderSubPreview(targetListId, pendingArray);
    };
    reader.readAsDataURL(file);
  }
}

function renderSubPreview(listId, pendingArray) {
  const list = $(listId);
  list.innerHTML = pendingArray.map((item, i) => `
    <div class="sub-preview-item" data-temp-id="${item.tempId}">
      <img src="${item.dataUrl || ''}" alt="" />
      ${item.uploading ? '<div class="sub-preview-uploading">up…</div>' : ''}
      <button class="sub-preview-remove" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  // 削除ボタン
  list.querySelectorAll(".sub-preview-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      pendingArray.splice(idx, 1);
      renderSubPreview(listId, pendingArray);
    });
  });
}

// 既存のサブ画像(path文字列)をプレビュー表示
function renderExistingSubImages(listId, pathArray, removeCallback) {
  const list = $(listId);
  list.innerHTML = pathArray.map((path, i) => `
    <div class="sub-preview-item" data-path="${escapeHtml(path)}">
      <img data-load-path="${escapeHtml(path)}" alt="" />
      <button class="sub-preview-remove" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  // 画像の読み込み
  list.querySelectorAll("img[data-load-path]").forEach((img) => {
    loadImageInto(img, img.dataset.loadPath);
  });
  // 削除ボタン
  list.querySelectorAll(".sub-preview-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      removeCallback(idx);
    });
  });
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

    // サブ画像をアップロード
    const subImagePaths = [];
    for (let i = 0; i < pendingSubImages.length; i++) {
      $("save-status").textContent = `サブ画像をアップロード中… (${i + 1}/${pendingSubImages.length})`;
      const sub = pendingSubImages[i];
      const subPath = `${IMAGES_DIR}/${id}-sub-${i + 1}.${sub.ext}`;
      await uploadImage(subPath, sub.base64, `Add sub-image: ${id} #${i + 1}`);
      subImagePaths.push(subPath);
    }

    $("save-status").textContent = "メタデータを保存中…";

    const entry = {
      id,
      image: imgPath,
      subImages: subImagePaths.length ? subImagePaths : undefined,
      category: $("input-category").value.trim() || undefined,
      prompt,
      createdAt: new Date().toISOString()
    };

    // entries に追加 → 保存(競合時は saveData が自動でマージしてリトライ)
    entries.unshift(entry);
    await saveData(`Add entry: ${id}`, (latestEntries) => {
      return [entry, ...latestEntries.filter((e) => e.id !== entry.id)];
    });

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

  // ドロップゾーン(メイン画像)
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

  // 追加モーダル:サブ画像ドロップゾーン
  const subDz = $("sub-dropzone");
  subDz.addEventListener("click", () => $("sub-file-input").click());
  subDz.addEventListener("dragover", (e) => { e.preventDefault(); subDz.classList.add("drag"); });
  subDz.addEventListener("dragleave", () => subDz.classList.remove("drag"));
  subDz.addEventListener("drop", (e) => {
    e.preventDefault();
    subDz.classList.remove("drag");
    handleSubFiles(e.dataTransfer.files, "sub-preview-list", pendingSubImages);
  });
  $("sub-file-input").addEventListener("change", (e) => {
    handleSubFiles(e.target.files, "sub-preview-list", pendingSubImages);
    e.target.value = "";
  });

  // 編集モーダル:サブ画像ドロップゾーン
  const editSubDz = $("edit-sub-dropzone");
  editSubDz.addEventListener("click", () => $("edit-sub-file-input").click());
  editSubDz.addEventListener("dragover", (e) => { e.preventDefault(); editSubDz.classList.add("drag"); });
  editSubDz.addEventListener("dragleave", () => editSubDz.classList.remove("drag"));
  editSubDz.addEventListener("drop", (e) => {
    e.preventDefault();
    editSubDz.classList.remove("drag");
    handleEditSubFiles(e.dataTransfer.files);
  });
  $("edit-sub-file-input").addEventListener("change", (e) => {
    handleEditSubFiles(e.target.files);
    e.target.value = "";
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
