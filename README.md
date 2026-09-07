# My Apps

我的網頁小工具集合,用 GitHub Pages 部署。首頁列出所有工具,點卡片即可開啟使用。

**線上位置**:`https://<你的帳號>.github.io/<repo名稱>/`

---

## 資料夾結構

```
my-apps/
├── index.html              ← 首頁(工具總覽,自動生成卡片)
├── README.md               ← 你正在看的這份
├── app-color-picker/       ← 一個 app = 一個資料夾
│   ├── index.html          ← app 本體(含內建使用說明)
│   └── README.md           ← 這個 app 的說明(在 GitHub 上瀏覽時會顯示)
└── app-word-counter/
    ├── index.html
    └── README.md
```

規則很簡單:**每個資料夾就是一個獨立的 app**,裡面一定要有 `index.html`。
GitHub Pages 會自動把 `app-color-picker/` 對應到網址 `.../app-color-picker/`。

---

## 如何新增一個 app

1. 建立一個新資料夾,名稱用小寫加連字號,例如 `app-my-tool/`。
2. 在裡面放一個 `index.html`(你的 app)。建議也放一份 `README.md` 說明用途。
3. 打開根目錄的 `index.html`,找到 `<script type="application/json" id="app-registry">` 這個區塊,
   複製一個 `{ }` 物件、改成你的資料:

   ```json
   {
     "slug": "app-my-tool",
     "name": "我的工具",
     "desc": "一句話介紹這個工具在做什麼。",
     "icon": "🛠️",
     "tags": ["工具"]
   }
   ```

   > `slug` 必須和資料夾名稱完全一致,這是首頁卡片連過去的路徑。

4. `git commit` 後 push,首頁就會自動多出一張卡片。

---

## 如何部署到 GitHub Pages

1. 把這個資料夾推到一個 GitHub repo(可設為 public)。
2. 進 repo 的 **Settings → Pages**。
3. **Source** 選 `Deploy from a branch`,Branch 選 `main`、資料夾選 `/ (root)`,按 Save。
4. 等一兩分鐘,GitHub 會給你一個網址:`https://<帳號>.github.io/<repo>/`。

之後每次 push 到 `main`,網站都會自動更新。

---

## 本機預覽

因為都是純靜態檔案,直接用瀏覽器打開 `index.html` 就能看。
若某些瀏覽器對本機檔案有限制,可在這個資料夾開一個簡易伺服器:

```bash
python3 -m http.server 8000
# 然後開 http://localhost:8000
```
