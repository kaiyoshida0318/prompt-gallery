# Prompt Gallery

ChatGPT / Midjourney / Stable Diffusion 等で生成した画像と、そのプロンプトをチームで共有・検索するための社内ツールです。

すべてブラウザから GitHub リポジトリに直接コミットされるため、サーバー不要で運用できます。

---

## ✦ 特徴

- **グリッド表示**:サムネイルで一覧、クリックで詳細
- **ドラッグ&ドロップ登録**:画像をドロップしてプロンプトを入力するだけ
- **プロンプトコピー**:ワンクリックで再利用
- **検索&タグ**:プロンプト・モデル・タグ横断検索
- **GitHub同期**:すべてのデータがリポジトリに保存されるのでバックアップ&履歴追跡も安心

---

## セットアップ手順

### 1. リポジトリを作る

1. GitHub で新しいリポジトリを作成(例: `prompt-gallery`)
   - **社外秘のプロンプトを扱う場合は Private リポジトリ + GitHub Pro/Team/Enterprise プランでのみ安全に運用可能です**
   - Free プランでは Private リポジトリを GitHub Pages で公開できません
2. 以下3ファイルをリポジトリの**ルート**に配置
   - `index.html`
   - `style.css`
   - `app.js`
3. 空の `images/` フォルダを作成(中に `.gitkeep` ファイルを置くと楽)

### 2. GitHub Pages を有効化

1. リポジトリ → **Settings** → **Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `main` / `/root` を選択 → Save
4. 1〜2分後 `https://<username>.github.io/<repo>/` でアクセス可能になります

### 3. Personal Access Token (PAT) を発行

画像&メタデータをコミットするため、ユーザー個別に PAT が必要です。

1. GitHub 右上のアイコン → **Settings** → **Developer settings**
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. 以下のように設定
   - **Token name**: `prompt-gallery` など
   - **Expiration**: 90 日 など
   - **Repository access**: **Only select repositories** → 対象リポジトリを選択
   - **Permissions** → **Repository permissions**:
     - **Contents**: **Read and write**
     - **Metadata**: Read-only (自動付与)
4. **Generate token** → 表示されたトークン(`github_pat_...`)をコピー

### 4. 初回アクセス

1. Pages の URL をブラウザで開く
2. 初回はセットアップ画面が表示されるので以下を入力
   - **GitHub Username**: リポジトリ所有者のユーザー名
   - **Repository Name**: リポジトリ名
   - **Branch**: `main`
   - **Personal Access Token**: 上で発行したトークン
3. **接続する** をクリックすれば利用開始

トークンはブラウザの `localStorage` にのみ保存され、GitHub以外の外部サーバーには送信されません。

---

## 運用メモ

### チームで使うには?

社員各自が自分の PAT を発行して、ブラウザに保存します。誰がコミットしたかは Git 履歴に残るので、変更追跡もできます。

### トークンが漏れたら?

1. GitHub → Settings → Developer settings → Personal access tokens → 該当トークンを **Revoke**
2. 新しいトークンを発行して再接続

### データはどこに?

- 画像: `images/xxxxxxxx.png`
- メタデータ: `data.json`(全エントリーを配列で保持)

いずれもリポジトリに普通のファイルとしてコミットされるので、GitHub上で直接見たり編集したりできます。

### 注意事項

- 大量の画像をアップすると、リポジトリが重くなります。1画像あたり数MB以下を推奨
- GitHub API は 1時間あたり 5000 リクエストの制限があります(通常利用では問題なし)
- 削除したファイルも Git 履歴には残り続けます(完全削除には `git filter-repo` 等が必要)

---

## ファイル構成

```
prompt-gallery/
├── index.html      # UI
├── style.css       # スタイル
├── app.js          # ロジック(GitHub API連携)
├── data.json       # 自動生成(エントリーのメタデータ)
├── images/         # 自動生成(アップロードされた画像)
└── README.md       # これ
```
