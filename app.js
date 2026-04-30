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
let tabs = [];          // タブ定義 [{id, name, icon}]
let tagDefs = [];       // タグ定義 [{id, name}]
let activeTabId = "_all"; // 選択中のタブID ("_all" は全て表示)
let activeTag = null;   // タグフィルタ
let currentDetailId = null;
let editingTabId = null; // タブ編集モーダル用
let inputTags = [];    // 追加モーダル用タグリスト
let editTags = [];     // 編集モーダル用タグリスト
let pendingImage = null; // { base64, mimeType, fileName }
let pendingSubImages = []; // 追加モーダル用サブ画像(保存前)
let pendingMaterialImages = []; // 追加モーダル用素材画像(保存前)
let editingSubImagesNew = []; // 編集モーダル:新規追加されたサブ画像
let editingSubImagesExisting = []; // 編集モーダル:既存のサブ画像path
let editingSubImagesRemoved = []; // 編集モーダル:削除予定の既存pathリスト
let editingMaterialImagesNew = []; // 編集モーダル:新規追加された素材画像
let editingMaterialImagesExisting = []; // 編集モーダル:既存の素材画像path
let editingMaterialImagesRemoved = []; // 編集モーダル:削除予定の素材画像path

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
    tabs = [];
    tagDefs = [];
    dataSha = null;
    return;
  }
  const data = await res.json();
  dataSha = data.sha;
  try {
    const json = JSON.parse(b64decode(data.content.replace(/\n/g, "")));
    entries = Array.isArray(json.entries) ? json.entries : [];
    tabs = Array.isArray(json.tabs) ? json.tabs : [];
    tagDefs = Array.isArray(json.tagDefs) ? json.tagDefs : [];

    // 既存entriesに使われているタグ名で、tagDefsに存在しないものを自動追加
    const definedNames = new Set(tagDefs.map((t) => t.name));
    const usedNames = new Set();
    entries.forEach((e) => (e.tags || []).forEach((n) => usedNames.add(n)));
    let added = false;
    for (const name of usedNames) {
      if (!definedNames.has(name)) {
        tagDefs.push({ id: "tag-" + genId(), name });
        added = true;
      }
    }
    if (added) {
      console.log(`既存タグから ${tagDefs.length - definedNames.size} 件を自動でタグ定義に追加しました`);
    }
  } catch (e) {
    console.error("data.json 解析失敗", e);
    entries = [];
    tabs = [];
    tagDefs = [];
  }
}

async function saveData(commitMessage, mergeFn) {
  // mergeFn: 競合時にどう entries をマージするかの関数 (oldEntries) => newEntries
  // 指定されない場合は現在の entries をそのまま使う(=最新を上書き)
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const body = {
      message: commitMessage,
      content: b64encode(JSON.stringify({ entries, tabs, tagDefs }, null, 2)),
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
      const myTabs = tabs.slice();
      const myTagDefs = tagDefs.slice();
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
      // tabsもマージ:自分が持ってる変更を優先
      const myTabMap = new Map(myTabs.map((t) => [t.id, t]));
      const mergedTabs = tabs.filter((t) => !myTabMap.has(t.id));
      mergedTabs.push(...myTabs);
      tabs = mergedTabs;
      // tagDefsもマージ:自分の変更を優先(削除も尊重)
      tagDefs = myTagDefs;
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
  let filtered = entries.filter((e) => {
    // タブ絞り込み:"_all"は全件表示、それ以外はtabIdが一致するもの
    if (activeTabId !== "_all" && e.tabId !== activeTabId) return false;
    if (activeTag && !(e.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    const hay = [e.title, e.prompt, e.negative, e.note, e.model, e.category, ...(e.tags || [])].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });

  // 「全て」タブのときは、カテゴリ(タブ)の並び順でソート
  // tabs配列の順番を優先し、未設定のものを最後に。同じカテゴリ内は作成日(新しい順)
  if (activeTabId === "_all") {
    const tabOrder = new Map();
    tabs.forEach((t, i) => tabOrder.set(t.id, i));
    filtered = filtered.slice().sort((a, b) => {
      const aOrder = a.tabId && tabOrder.has(a.tabId) ? tabOrder.get(a.tabId) : Number.MAX_SAFE_INTEGER;
      const bOrder = b.tabId && tabOrder.has(b.tabId) ? tabOrder.get(b.tabId) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      // 同じカテゴリ内は新しい順
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
  }

  $("stat-count").textContent = entries.length;

  // タブバーを再描画(各タブの件数も計算するため)
  renderTabBar();

  const gallery = $("gallery");
  $("loading").style.display = "none";
  if (entries.length === 0) {
    $("empty-state").style.display = "block";
    gallery.innerHTML = "";
    renderTagFilters();
    return;
  }
  if (filtered.length === 0) {
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
        ${e.title ? `<h3 class="card-title">${escapeHtml(e.title)}</h3>` : '<h3 class="card-title card-title-placeholder">無題</h3>'}
        <div class="card-meta">
          <span class="card-model">${escapeHtml(getTabNameById(e.tabId) || "—")}</span>
          <span>${fmtDate(e.createdAt)}</span>
        </div>
        ${e.tags && e.tags.length ? `<div class="card-tags">${e.tags.map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join("")}</div>` : ''}
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

// ---------- タブバーの描画 ----------
function renderTabBar() {
  const tabList = $("tab-list");
  // 各タブに属するエントリー数をカウント
  const counts = { _all: entries.length };
  for (const e of entries) {
    if (e.tabId) counts[e.tabId] = (counts[e.tabId] || 0) + 1;
  }
  // 「全て」+ 各タブ
  // 「全て」タブにマーカークラスを付与(視覚的に区別)
  const allBtn = `
    <div class="tab-item tab-item-all ${activeTabId === '_all' ? 'active' : ''}" data-tab-id="_all">
      <span class="tab-item-icon">📚</span>
      <span class="tab-item-name">全て</span>
      <span class="tab-item-count">${counts._all || 0}</span>
    </div>
  `;
  const tabsHtml = tabs.map((t, i) => {
    const isActive = activeTabId === t.id;
    return `
    <div class="tab-item ${isActive ? 'active' : ''}" data-tab-id="${escapeHtml(t.id)}">
      <span class="tab-item-icon">${escapeHtml(t.icon || '🏷️')}</span>
      <span class="tab-item-name">${escapeHtml(t.name)}</span>
      <span class="tab-item-count">${counts[t.id] || 0}</span>
      <span class="tab-item-actions">
        ${i > 0 ? `<button class="tab-mini-btn" data-action="left" data-tab-id="${escapeHtml(t.id)}" title="左へ移動">◀</button>` : ''}
        ${i < tabs.length - 1 ? `<button class="tab-mini-btn" data-action="right" data-tab-id="${escapeHtml(t.id)}" title="右へ移動">▶</button>` : ''}
        <button class="tab-mini-btn" data-action="edit" data-tab-id="${escapeHtml(t.id)}" title="編集">✎</button>
      </span>
    </div>
  `;
  }).join("");
  tabList.innerHTML = tabsHtml + allBtn;

  // タブクリックで切り替え
  tabList.querySelectorAll(".tab-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      // ミニボタンのクリックは別処理
      if (e.target.closest(".tab-mini-btn")) return;
      activeTabId = el.dataset.tabId;
      render();
    });
  });
  // ミニボタン
  tabList.querySelectorAll(".tab-mini-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const tabId = btn.dataset.tabId;
      if (action === "left") moveTab(tabId, -1);
      else if (action === "right") moveTab(tabId, 1);
      else if (action === "edit") openTabEdit(tabId);
    });
  });
}

// ---------- タブ操作 ----------
function moveTab(tabId, delta) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= tabs.length) return;
  const [item] = tabs.splice(idx, 1);
  tabs.splice(newIdx, 0, item);
  saveData(`Reorder tab: ${item.name}`).then(render).catch((err) => alert("並び替え失敗: " + err.message));
}

function openNewTab() {
  editingTabId = null;
  $("tab-edit-title").textContent = "新しいカテゴリを追加";
  $("tab-edit-icon").value = "📦";
  $("tab-edit-name").value = "";
  $("btn-tab-delete").style.display = "none";
  closeAllModals();
  $("tab-edit-modal").style.display = "flex";
  setTimeout(() => $("tab-edit-name").focus(), 50);
}

function openTabEdit(tabId) {
  const t = tabs.find((x) => x.id === tabId);
  if (!t) return;
  editingTabId = tabId;
  $("tab-edit-title").textContent = "カテゴリを編集";
  $("tab-edit-icon").value = t.icon || "🏷️";
  $("tab-edit-name").value = t.name || "";
  $("btn-tab-delete").style.display = "inline-block";
  closeAllModals();
  $("tab-edit-modal").style.display = "flex";
  setTimeout(() => $("tab-edit-name").focus(), 50);
}

async function saveTab() {
  const name = $("tab-edit-name").value.trim();
  const icon = $("tab-edit-icon").value.trim() || "🏷️";
  if (!name) {
    alert("タブ名を入力してください");
    return;
  }

  const btn = $("btn-tab-save");
  btn.disabled = true;

  try {
    if (editingTabId) {
      // 編集
      const t = tabs.find((x) => x.id === editingTabId);
      if (!t) throw new Error("対象カテゴリが見つかりません");
      t.name = name;
      t.icon = icon;
      await saveData(`Update tab: ${name}`);
    } else {
      // 新規
      const newTab = { id: "tab-" + genId(), name, icon };
      tabs.push(newTab);
      await saveData(`Add tab: ${name}`);
      activeTabId = newTab.id;
    }
    $("tab-edit-modal").style.display = "none";
    render();
  } catch (err) {
    alert("保存失敗: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function deleteTab() {
  if (!editingTabId) return;
  const t = tabs.find((x) => x.id === editingTabId);
  if (!t) return;
  if (!confirm(`カテゴリ「${t.name}」を削除しますか?\n(中の画像は削除されません。「全て」で見られます)`)) return;

  try {
    // タブ自体を削除
    tabs = tabs.filter((x) => x.id !== editingTabId);
    // このタブに属していたエントリーは tabId を未設定に
    entries.forEach((e) => {
      if (e.tabId === editingTabId) delete e.tabId;
    });
    await saveData(`Delete tab: ${t.name}`);
    if (activeTabId === editingTabId) activeTabId = "_all";
    $("tab-edit-modal").style.display = "none";
    render();
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

// 追加・編集モーダルのタブ選択を最新のtabsで埋める
function refreshTabSelectOptions() {
  const optionsHtml = '<option value="">— カテゴリなし(全てに表示)—</option>' +
    tabs.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.icon || '🏷️')} ${escapeHtml(t.name)}</option>`).join("");
  $("input-tab-id").innerHTML = optionsHtml;
  $("edit-tab-id").innerHTML = optionsHtml;
}

// 所属カテゴリ(タブ)名を取得するヘルパー
function getTabNameById(tabId) {
  if (!tabId) return null;
  const t = tabs.find((x) => x.id === tabId);
  return t ? t.name : null;
}

// ---------- タグピッカー ----------
// 選択済みタグの表示
function renderTagPickerSelected(selectedId, tagsArray, popupId, optionsId) {
  const sel = $(selectedId);
  sel.innerHTML = tagsArray.map((tag, i) => `
    <span class="tag-chip-input">
      ${escapeHtml(tag)}
      <span class="tag-chip-input-remove" data-index="${i}" title="削除">×</span>
    </span>
  `).join("");
  sel.querySelectorAll(".tag-chip-input-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      tagsArray.splice(idx, 1);
      renderTagPickerSelected(selectedId, tagsArray, popupId, optionsId);
      // ポップアップが開いてたら選択状態も更新
      if ($(popupId).style.display !== "none") {
        renderTagPickerOptions(optionsId, tagsArray, popupId, selectedId);
      }
    });
  });
}

// ポップアップ内の候補表示
function renderTagPickerOptions(optionsId, tagsArray, popupId, selectedId) {
  const opts = $(optionsId);
  if (tagDefs.length === 0) {
    opts.innerHTML = '<p class="tag-picker-empty">登録されたタグがありません。右上の「🏷️ タグ管理」から追加してください。</p>';
    return;
  }
  // 名前順
  const sorted = tagDefs.slice().sort((a, b) => a.name.localeCompare(b.name, "ja"));
  opts.innerHTML = sorted.map((td) => {
    const selected = tagsArray.includes(td.name);
    return `<span class="tag-picker-option ${selected ? 'selected' : ''}" data-name="${escapeHtml(td.name)}">${escapeHtml(td.name)}</span>`;
  }).join("");
  opts.querySelectorAll(".tag-picker-option").forEach((el) => {
    el.addEventListener("click", () => {
      const name = el.dataset.name;
      const idx = tagsArray.indexOf(name);
      if (idx === -1) {
        tagsArray.push(name);
      } else {
        tagsArray.splice(idx, 1);
      }
      renderTagPickerOptions(optionsId, tagsArray, popupId, selectedId);
      renderTagPickerSelected(selectedId, tagsArray, popupId, optionsId);
    });
  });
}

// ピッカーUIの初期化(イベントハンドラ登録)
function setupTagPicker(prefix, tagsArray) {
  // prefix は "input" or "edit"
  const toggleBtn = $(`${prefix}-tags-toggle`);
  const popup = $(`${prefix}-tags-popup`);
  const selectedId = `${prefix}-tags-selected`;
  const optionsId = `${prefix}-tags-options`;

  // 既存リスナーをクリアするため、ボタン要素を置き換え
  const newToggle = toggleBtn.cloneNode(true);
  toggleBtn.parentNode.replaceChild(newToggle, toggleBtn);
  newToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = popup.style.display !== "none";
    if (isOpen) {
      popup.style.display = "none";
    } else {
      renderTagPickerOptions(optionsId, tagsArray, `${prefix}-tags-popup`, selectedId);
      popup.style.display = "block";
    }
  });
  // 外側クリックで閉じる
  document.addEventListener("click", (e) => {
    if (popup.style.display !== "none") {
      const wrap = $(`${prefix}-tags-wrap`);
      if (!wrap.contains(e.target)) popup.style.display = "none";
    }
  });
}

// ---------- タグ管理 ----------
function openTagManager() {
  closeAllModals();
  $("tag-mgr-new-name").value = "";
  renderTagManager();
  $("tag-mgr-modal").style.display = "flex";
  setTimeout(() => $("tag-mgr-new-name").focus(), 50);
}

function renderTagManager() {
  const list = $("tag-mgr-list");
  if (tagDefs.length === 0) {
    list.innerHTML = '<div class="tag-mgr-empty">タグがまだありません。上から追加してください。</div>';
    return;
  }
  // 各タグの使用件数を集計
  const usageCount = {};
  entries.forEach((e) => {
    (e.tags || []).forEach((n) => {
      usageCount[n] = (usageCount[n] || 0) + 1;
    });
  });

  const sorted = tagDefs.slice().sort((a, b) => a.name.localeCompare(b.name, "ja"));
  list.innerHTML = sorted.map((td) => `
    <div class="tag-mgr-item" data-id="${escapeHtml(td.id)}">
      <span class="tag-mgr-item-name">${escapeHtml(td.name)}</span>
      <span class="tag-mgr-item-count">${usageCount[td.name] || 0} 件</span>
      <button class="tag-mgr-btn" data-action="rename" data-id="${escapeHtml(td.id)}">名前変更</button>
      <button class="tag-mgr-btn danger" data-action="delete" data-id="${escapeHtml(td.id)}">削除</button>
    </div>
  `).join("");

  list.querySelectorAll(".tag-mgr-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "rename") startRenameTag(id);
      else if (action === "delete") deleteTagDef(id);
    });
  });
}

function startRenameTag(tagId) {
  const td = tagDefs.find((x) => x.id === tagId);
  if (!td) return;
  const item = document.querySelector(`.tag-mgr-item[data-id="${CSS.escape(tagId)}"]`);
  if (!item) return;
  const oldName = td.name;
  item.innerHTML = `
    <input class="tag-mgr-edit-input" type="text" value="${escapeHtml(oldName)}" />
    <button class="tag-mgr-btn" data-action="confirm">OK</button>
    <button class="tag-mgr-btn" data-action="cancel">キャンセル</button>
  `;
  const input = item.querySelector(".tag-mgr-edit-input");
  input.focus();
  input.select();
  const confirm = async () => {
    const newName = input.value.trim();
    if (!newName) {
      alert("名前を入力してください");
      return;
    }
    if (newName === oldName) {
      renderTagManager();
      return;
    }
    if (tagDefs.some((x) => x.id !== tagId && x.name === newName)) {
      alert("同じ名前のタグが既にあります");
      return;
    }
    try {
      // タグ定義を更新
      td.name = newName;
      // 全entriesのtags内の旧名前を新名前に置換
      entries.forEach((e) => {
        if (e.tags) {
          e.tags = e.tags.map((n) => n === oldName ? newName : n);
        }
      });
      await saveData(`Rename tag: ${oldName} -> ${newName}`);
      renderTagManager();
      render();
    } catch (err) {
      alert("変更失敗: " + err.message);
      td.name = oldName; // ロールバック
      renderTagManager();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    else if (e.key === "Escape") { e.preventDefault(); renderTagManager(); }
  });
  item.querySelector('[data-action="confirm"]').addEventListener("click", confirm);
  item.querySelector('[data-action="cancel"]').addEventListener("click", renderTagManager);
}

async function deleteTagDef(tagId) {
  const td = tagDefs.find((x) => x.id === tagId);
  if (!td) return;
  // 使用件数チェック
  let count = 0;
  entries.forEach((e) => { if ((e.tags || []).includes(td.name)) count++; });
  const msg = count > 0
    ? `タグ「${td.name}」を削除しますか?\n${count}件の画像から自動的にタグが外されます。`
    : `タグ「${td.name}」を削除しますか?`;
  if (!confirm(msg)) return;

  try {
    tagDefs = tagDefs.filter((x) => x.id !== tagId);
    // 全entriesから該当タグを削除
    entries.forEach((e) => {
      if (e.tags) {
        e.tags = e.tags.filter((n) => n !== td.name);
        if (e.tags.length === 0) delete e.tags;
      }
    });
    await saveData(`Delete tag: ${td.name}`);
    renderTagManager();
    render();
  } catch (err) {
    alert("削除失敗: " + err.message);
  }
}

async function addTagDef() {
  const name = $("tag-mgr-new-name").value.trim();
  if (!name) {
    alert("タグ名を入力してください");
    return;
  }
  if (tagDefs.some((x) => x.name === name)) {
    alert("同じ名前のタグが既にあります");
    return;
  }
  try {
    tagDefs.push({ id: "tag-" + genId(), name });
    await saveData(`Add tag: ${name}`);
    $("tag-mgr-new-name").value = "";
    renderTagManager();
  } catch (err) {
    alert("追加失敗: " + err.message);
  }
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

// 編集モーダル用:新規素材画像を読み込み
function handleEditMaterialFiles(files) {
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
      editingMaterialImagesNew.push({ base64, mimeType: file.type, ext, dataUrl });
      refreshEditMaterialPreview();
    };
    reader.readAsDataURL(file);
  }
}

// ---------- 詳細モーダル ----------
function closeAllModals() {
  ["add-modal", "edit-modal", "detail-modal", "tab-edit-modal", "tag-mgr-modal"].forEach((id) => {
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
  $("detail-date").textContent = fmtDate(e.createdAt);

  // タイトル
  if (e.title) {
    $("detail-title").style.display = "block";
    $("detail-title").textContent = e.title;
  } else $("detail-title").style.display = "none";

  // サブ画像(新)
  if (e.subImages && e.subImages.length) {
    $("sub-images-section").style.display = "block";
    $("detail-sub-images").innerHTML = e.subImages.map((path) =>
      `<img data-load-path="${escapeHtml(path)}" data-full-path="${escapeHtml(path)}" alt="" />`
    ).join("");
    $("detail-sub-images").querySelectorAll("img[data-load-path]").forEach((img) => {
      loadImageInto(img, img.dataset.loadPath);
      img.addEventListener("click", () => {
        if (img.src) window.open(img.src);
      });
    });
  } else $("sub-images-section").style.display = "none";

  // 素材画像
  if (e.materialImages && e.materialImages.length) {
    $("material-images-section").style.display = "block";
    $("detail-material-images").innerHTML = e.materialImages.map((path) =>
      `<img data-load-path="${escapeHtml(path)}" alt="" />`
    ).join("");
    $("detail-material-images").querySelectorAll("img[data-load-path]").forEach((img) => {
      loadImageInto(img, img.dataset.loadPath);
      img.addEventListener("click", () => {
        if (img.src) window.open(img.src);
      });
    });
  } else $("material-images-section").style.display = "none";

  // プロンプトはコピー用に保持(画面には表示しない)
  $("detail-prompt").textContent = e.prompt || "";

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
    // 素材画像も削除(失敗しても続行)
    for (const matPath of (e.materialImages || [])) {
      try {
        await deleteFile(matPath, null, `Delete material-image: ${e.id}`);
      } catch (err) {
        console.warn("素材画像削除失敗(続行):", matPath, err);
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
  refreshTabSelectOptions();
  // プレビュー画像(詳細モーダルのimgを流用して即時表示)
  $("edit-preview-img").src = "";
  loadImageInto($("edit-preview-img"), e.image);
  // 既存の値をフォームに読み込み
  $("edit-prompt").value = e.prompt || "";
  $("edit-title").value = e.title || "";
  $("edit-tab-id").value = e.tabId || "";
  // 配列の参照を維持しつつ内容だけ更新(setupTagPickerが起動時の参照を使い続けるため)
  editTags.length = 0;
  (e.tags || []).forEach((t) => editTags.push(t));
  renderTagPickerSelected("edit-tags-selected", editTags, "edit-tags-popup", "edit-tags-options");
  $("edit-tags-popup").style.display = "none";
  $("edit-status").textContent = "";
  $("edit-status").className = "save-status";

  // サブ画像の状態を初期化
  editingSubImagesNew = [];
  editingSubImagesExisting = (e.subImages || []).slice();
  editingSubImagesRemoved = [];
  refreshEditSubPreview();

  // 素材画像の状態を初期化
  editingMaterialImagesNew = [];
  editingMaterialImagesExisting = (e.materialImages || []).slice();
  editingMaterialImagesRemoved = [];
  refreshEditMaterialPreview();

  $("edit-sub-file-input").value = "";
  $("edit-material-file-input").value = "";
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

// 編集モーダルの素材画像プレビュー全体を再描画
function refreshEditMaterialPreview() {
  const list = $("edit-material-preview-list");
  const existingHtml = editingMaterialImagesExisting.map((path, i) => `
    <div class="sub-preview-item" data-kind="existing" data-index="${i}">
      <img data-load-path="${escapeHtml(path)}" alt="" />
      <button class="sub-preview-remove" data-kind="existing" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  const newHtml = editingMaterialImagesNew.map((item, i) => `
    <div class="sub-preview-item" data-kind="new" data-index="${i}">
      <img src="${item.dataUrl}" alt="" />
      <button class="sub-preview-remove" data-kind="new" data-index="${i}" title="削除">×</button>
    </div>
  `).join("");
  list.innerHTML = existingHtml + newHtml;

  list.querySelectorAll("img[data-load-path]").forEach((img) => {
    loadImageInto(img, img.dataset.loadPath);
  });
  list.querySelectorAll(".sub-preview-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      if (btn.dataset.kind === "existing") {
        editingMaterialImagesRemoved.push(editingMaterialImagesExisting[idx]);
        editingMaterialImagesExisting.splice(idx, 1);
      } else {
        editingMaterialImagesNew.splice(idx, 1);
      }
      refreshEditMaterialPreview();
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

    // 新規素材画像をアップロード
    const newMaterialPaths = [];
    const existingMatCount = editingMaterialImagesExisting.length;
    for (let i = 0; i < editingMaterialImagesNew.length; i++) {
      $("edit-status").textContent = `素材画像をアップロード中… (${i + 1}/${editingMaterialImagesNew.length})`;
      const mat = editingMaterialImagesNew[i];
      const matPath = `${IMAGES_DIR}/${entryId}-material-${Date.now()}-${existingMatCount + i + 1}.${mat.ext}`;
      await uploadImage(matPath, mat.base64, `Add material-image: ${entryId}`);
      newMaterialPaths.push(matPath);
    }

    // 削除予定の素材画像を削除
    for (const path of editingMaterialImagesRemoved) {
      try {
        await deleteFile(path, null, `Delete material-image: ${entryId}`);
      } catch (e) {
        console.warn("素材画像削除失敗(続行):", path, e);
      }
    }

    $("edit-status").textContent = "保存中…";

    // 最終的なサブ画像リストと素材画像リスト
    const finalSubImages = [...editingSubImagesExisting, ...newSubPaths];
    const finalMaterialImages = [...editingMaterialImagesExisting, ...newMaterialPaths];

    // 元の image, id, createdAt は保持して、他を更新
    const updated = {
      ...entries[idx],
      prompt,
      title: $("edit-title").value.trim() || undefined,
      tabId: $("edit-tab-id").value || undefined,
      tags: editTags.length ? editTags.slice() : undefined,
      subImages: finalSubImages.length ? finalSubImages : undefined,
      materialImages: finalMaterialImages.length ? finalMaterialImages : undefined,
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
      editingMaterialImagesNew = [];
      editingMaterialImagesExisting = [];
      editingMaterialImagesRemoved = [];
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
  pendingMaterialImages = [];
  $("preview-wrap").style.display = "none";
  $("dropzone").style.display = "block";
  $("file-input").value = "";
  $("sub-file-input").value = "";
  $("sub-preview-list").innerHTML = "";
  $("material-file-input").value = "";
  $("material-preview-list").innerHTML = "";
  $("input-prompt").value = "";
  $("input-title").value = "";
  inputTags.length = 0;
  renderTagPickerSelected("input-tags-selected", inputTags, "input-tags-popup", "input-tags-options");
  $("input-tags-popup").style.display = "none";
  // 現在見ているタブをデフォルト所属に(「全て」のときは未設定)
  $("input-tab-id").value = activeTabId === "_all" ? "" : activeTabId;
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

    // 素材画像をアップロード
    const materialImagePaths = [];
    for (let i = 0; i < pendingMaterialImages.length; i++) {
      $("save-status").textContent = `素材画像をアップロード中… (${i + 1}/${pendingMaterialImages.length})`;
      const mat = pendingMaterialImages[i];
      const matPath = `${IMAGES_DIR}/${id}-material-${i + 1}.${mat.ext}`;
      await uploadImage(matPath, mat.base64, `Add material-image: ${id} #${i + 1}`);
      materialImagePaths.push(matPath);
    }

    $("save-status").textContent = "メタデータを保存中…";

    const entry = {
      id,
      image: imgPath,
      subImages: subImagePaths.length ? subImagePaths : undefined,
      materialImages: materialImagePaths.length ? materialImagePaths : undefined,
      tabId: $("input-tab-id").value || undefined,
      title: $("input-title").value.trim() || undefined,
      tags: inputTags.length ? inputTags.slice() : undefined,
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
    refreshTabSelectOptions();
      resetAddForm();
    $("add-modal").style.display = "flex";
  });

  // タブ追加ボタン
  $("btn-add-tab").addEventListener("click", openNewTab);

  // タブ編集モーダル:アイコン候補のクリック
  document.querySelectorAll(".icon-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("tab-edit-icon").value = chip.dataset.icon;
    });
  });
  // タブ保存
  $("btn-tab-save").addEventListener("click", saveTab);
  $("btn-tab-delete").addEventListener("click", deleteTab);
  // Enter で保存
  $("tab-edit-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveTab(); }
  });

  // タグ管理
  $("btn-tag-mgr").addEventListener("click", openTagManager);
  $("tag-mgr-add").addEventListener("click", addTagDef);
  $("tag-mgr-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTagDef(); }
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

  // 追加モーダル:素材画像ドロップゾーン
  const matDz = $("material-dropzone");
  matDz.addEventListener("click", () => $("material-file-input").click());
  matDz.addEventListener("dragover", (e) => { e.preventDefault(); matDz.classList.add("drag"); });
  matDz.addEventListener("dragleave", () => matDz.classList.remove("drag"));
  matDz.addEventListener("drop", (e) => {
    e.preventDefault();
    matDz.classList.remove("drag");
    handleSubFiles(e.dataTransfer.files, "material-preview-list", pendingMaterialImages);
  });
  $("material-file-input").addEventListener("change", (e) => {
    handleSubFiles(e.target.files, "material-preview-list", pendingMaterialImages);
    e.target.value = "";
  });

  // 編集モーダル:素材画像ドロップゾーン
  const editMatDz = $("edit-material-dropzone");
  editMatDz.addEventListener("click", () => $("edit-material-file-input").click());
  editMatDz.addEventListener("dragover", (e) => { e.preventDefault(); editMatDz.classList.add("drag"); });
  editMatDz.addEventListener("dragleave", () => editMatDz.classList.remove("drag"));
  editMatDz.addEventListener("drop", (e) => {
    e.preventDefault();
    editMatDz.classList.remove("drag");
    handleEditMaterialFiles(e.dataTransfer.files);
  });
  $("edit-material-file-input").addEventListener("change", (e) => {
    handleEditMaterialFiles(e.target.files);
    e.target.value = "";
  });

  // 保存
  $("btn-save").addEventListener("click", saveEntry);

  // 検索
  $("search-input").addEventListener("input", render);

  // コピー
  $("copy-negative").addEventListener("click", (e) => copyText($("detail-negative").textContent, e.target));

  // 削除
  $("btn-delete").addEventListener("click", deleteEntry);

  // 編集
  $("btn-edit").addEventListener("click", openEdit);
  $("btn-update").addEventListener("click", updateEntry);

  // タグ入力フィールド初期化
  setupTagPicker("input", inputTags);
  setupTagPicker("edit", editTags);

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
