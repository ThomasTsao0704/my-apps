/**
 * 盤後判斷簿 — 前端
 * 對應後端：股票市場判斷與損益追蹤 API v2（Google Apps Script）
 *
 * 純原生 JavaScript，無建置步驟，可直接部署於 GitHub Pages。
 */
'use strict';

const APP_VERSION = '1.0.0';

const LS = {
  config: 'pj.config',
  prefs: 'pj.prefs',
  queue: 'pj.queue',
  cache: 'pj.cache'
};

const DIRECTIONS = ['看多', '看空', '中性'];
const DIR_CLASS = { '看多': 'dir-long', '看空': 'dir-short', '中性': 'dir-neutral' };
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const state = {
  ym: null,             // { y, m } 行事曆目前月份
  selected: null,       // 行事曆選取日期
  records: { page: 1, filters: {} },
  statsRange: 'month',
  stocks: null,         // 股票清單快取（本次工作階段）
  syncing: false,
  renderSeq: 0
};


/* ============================================================
 * 工具
 * ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function persist(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 儲存空間不足或被封鎖時忽略
  }
}

function getConfig() {
  const saved = load(LS.config, {});
  const preset = window.APP_CONFIG || {};
  return {
    apiUrl: (saved.apiUrl || preset.apiUrl || '').trim(),
    token: saved.token || ''
  };
}

function getPrefs() {
  return Object.assign({ colors: 'tw', theme: 'system' }, load(LS.prefs, {}));
}

function applyPrefs() {
  const p = getPrefs();
  const root = document.documentElement;
  if (p.colors === 'intl') root.dataset.colors = 'intl';
  else delete root.dataset.colors;
  if (p.theme === 'light' || p.theme === 'dark') root.dataset.theme = p.theme;
  else delete root.dataset.theme;
}

/** 台北時區的今日 yyyy-MM-dd */
function todayTaipei() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function pad2(n) { return String(n).padStart(2, '0'); }

function ymOf(date) {
  const [y, m] = date.split('-').map(Number);
  return { y, m };
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}

function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function signClass(n) {
  if (n === null || n === undefined) return 'flat';
  return n > 0 ? 'gain' : n < 0 ? 'loss' : 'flat';
}

const nf = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });

function fmtNum(n) {
  return n === null || n === undefined ? '—' : nf.format(n);
}

function fmtMoney(n, { round } = {}) {
  if (n === null || n === undefined) return '—';
  const v = round ? Math.round(Math.abs(n)) : Math.abs(n);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + nf.format(v);
}

/**
 * 精簡金額：600、2.6千、1.4萬、3.2億。
 * 行事曆格子很窄，獲利不加「+」（顏色已表達），虧損保留「−」。
 */
function fmtCompact(n, { plus = false } = {}) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : (plus && n > 0 ? '+' : '');
  const short = (v, unit) => {
    const digits = v >= 100 ? 0 : 1;
    return v.toFixed(digits).replace(/\.0$/, '') + unit;
  };
  if (abs >= 1e8) return sign + short(abs / 1e8, '億');
  if (abs >= 1e4) return sign + short(abs / 1e4, '萬');
  if (abs >= 1e3) return sign + short(abs / 1e3, '千');
  return sign + Math.round(abs);
}

function fmtPct(r) {
  return r === null || r === undefined ? '—' : (r * 100).toFixed(1) + '%';
}

function fmtTime(ts) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ts));
}

function toast(message, type) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 4500 : 2600);
}

function setLoading(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('is-loading', on);
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}


/* ============================================================
 * API
 * ============================================================ */

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 所有請求都用 POST + text/plain，避免 CORS 預檢。
 */
async function api(action, payload = {}, { timeout = 25000 } = {}) {
  const { apiUrl, token } = getConfig();

  if (!apiUrl) {
    throw new ApiError('not_configured', '尚未設定 API 網址');
  }

  const body = { action, payload };
  if (token) body.token = token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;

  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (err) {
    throw new ApiError('network', err.name === 'AbortError' ? '連線逾時，請稍後再試' : '無法連線，請檢查網路');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ApiError('http_' + res.status, '伺服器回應 HTTP ' + res.status);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new ApiError('bad_response', '回應不是 JSON。請確認網頁應用程式的存取權為「所有人」，並使用 /exec 網址');
  }

  if (!json.ok) {
    throw new ApiError(json.error || 'error', json.message || json.error || '發生未知錯誤');
  }

  return json.data;
}

/**
 * 讀取並在本機留一份副本；離線時回傳最後一次成功的結果。
 */
async function apiRead(action, payload = {}) {
  const key = action + '|' + JSON.stringify(payload);

  try {
    const data = await api(action, payload);
    const cache = load(LS.cache, {});
    cache[key] = { t: Date.now(), data };
    const keys = Object.keys(cache).sort((a, b) => cache[b].t - cache[a].t);
    keys.slice(60).forEach(k => delete cache[k]);
    persist(LS.cache, cache);
    return { data, stale: false };
  } catch (err) {
    if (err.code === 'network') {
      const hit = load(LS.cache, {})[key];
      if (hit) return { data: hit.data, stale: true, at: hit.t };
    }
    throw err;
  }
}

async function loadStocks(force) {
  if (state.stocks && !force) return state.stocks;
  const { data } = await apiRead('stocks', { page: 1, pageSize: 200 });
  state.stocks = data.items;
  return state.stocks;
}

function stockName(code) {
  const s = (state.stocks || []).find(x => x.code === code);
  return s ? s.name : '';
}


/* ============================================================
 * 離線佇列
 * ============================================================ */

function getQueue() {
  return load(LS.queue, []);
}

function enqueue(item) {
  const q = getQueue().filter(x => !(x.date === item.date && x.code === item.code));
  q.push(item);
  persist(LS.queue, q);
  updateStatus();
}

async function syncQueue({ silent } = {}) {
  let q = getQueue();
  if (!q.length || state.syncing || !navigator.onLine) return;

  state.syncing = true;
  updateStatus();

  try {
    while (q.length) {
      const batch = q.slice(0, 100);
      await api('judgment.saveMany', { items: batch });
      q = q.slice(batch.length);
      persist(LS.queue, q);
    }
    toast('離線紀錄已同步');
    route();
  } catch (err) {
    if (!silent || err.code !== 'network') {
      toast('同步失敗：' + err.message, 'error');
    }
  } finally {
    state.syncing = false;
    updateStatus();
  }
}

function updateStatus() {
  const chip = $('#status-chip');
  const pending = getQueue().length;
  const offline = !navigator.onLine;

  if (state.syncing) {
    chip.textContent = '同步中…';
    chip.className = 'status-chip';
    chip.hidden = false;
  } else if (pending) {
    chip.textContent = '待同步 ' + pending;
    chip.className = 'status-chip' + (offline ? ' offline' : '');
    chip.hidden = false;
  } else if (offline) {
    chip.textContent = '離線';
    chip.className = 'status-chip offline';
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}


/* ============================================================
 * 共用片段
 * ============================================================ */

function errorBlock(err, retryLabel = '重試') {
  if (err.code === 'not_configured') {
    return `
      <div class="callout warn">
        <h3>尚未連接後端</h3>
        <p>請先到設定頁填入 Apps Script 網頁應用程式的 /exec 網址。</p>
        <a class="btn btn-primary btn-sm" href="#settings">前往設定</a>
      </div>`;
  }
  if (err.code === 'unauthorized') {
    return `
      <div class="callout error">
        <h3>授權失敗</h3>
        <p>後端已啟用 API Token，請到設定頁確認 Token 是否正確。</p>
        <a class="btn btn-sm" href="#settings">前往設定</a>
      </div>`;
  }
  return `
    <div class="callout error">
      <h3>載入失敗</h3>
      <p>${esc(err.message)}</p>
      <button class="btn btn-sm" type="button" data-retry>${esc(retryLabel)}</button>
    </div>`;
}

function bindRetry(root) {
  $$('[data-retry]', root).forEach(b => b.addEventListener('click', () => route()));
}

function staleNote(res) {
  return res.stale
    ? `<p class="stale-note">離線中，顯示 ${esc(fmtTime(res.at))} 的資料</p>`
    : '';
}

function judgmentItem(j, { showDate } = {}) {
  const name = j.stockName || stockName(j.code);
  const hasPrices = j.todayAfter !== null || j.nextDayAfter !== null;
  const href = `#entry?date=${encodeURIComponent(j.date)}&code=${encodeURIComponent(j.code)}`;

  return `
    <li class="jitem">
      <a href="${href}">
        ${showDate ? `<div class="jdate">${esc(j.date)}（${weekdayOf(j.date)}）</div>` : ''}
        <div class="jhead">
          <span class="code">${esc(j.code)}</span>
          ${name ? `<span class="name">${esc(name)}</span>` : ''}
          <span class="dir ${DIR_CLASS[j.direction] || 'dir-neutral'}">${esc(j.direction)}</span>
          ${j.profit === null
            ? '<span class="pnl none">未結算</span>'
            : `<span class="pnl ${signClass(j.profit)}">${fmtMoney(j.profit)}</span>`}
        </div>
        ${j.reason ? `<p class="reason">${esc(j.reason)}</p>` : ''}
        ${hasPrices ? `
          <div class="prices">
            當日 ${fmtNum(j.todayAfter)}<span class="arrow">→</span>次日 ${fmtNum(j.nextDayAfter)}
          </div>` : ''}
      </a>
    </li>`;
}

function pendingForDate(date) {
  return getQueue().filter(q => q.date === date);
}


/* ============================================================
 * 行事曆
 * ============================================================ */

async function renderCalendar(params) {
  const el = $('#view-calendar');
  const seq = ++state.renderSeq;

  if (params.get('date')) {
    state.selected = params.get('date');
    state.ym = ymOf(state.selected);
  }
  if (!state.ym) state.ym = ymOf(todayTaipei());

  const { y, m } = state.ym;
  const today = todayTaipei();

  el.innerHTML = `
    <div class="view-head cal-head">
      <div class="month-nav">
        <button class="icon-btn" type="button" data-month="-1" aria-label="上個月">
          <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <h1 class="month-label"><span class="num">${y}</span> 年 <span class="num">${m}</span> 月</h1>
        <button class="icon-btn" type="button" data-month="1" aria-label="下個月">
          <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>
      <button class="btn btn-sm" type="button" data-today>今天</button>
    </div>
    <div id="cal-summary"></div>
    <div class="card cal">
      <div class="cal-week">${WEEKDAYS.map(d => `<div>${d}</div>`).join('')}</div>
      <div class="cal-grid is-loading-grid" id="cal-grid">${calendarCells(y, m, null, today)}</div>
      <div class="cal-legend">
        <span><i class="lg-gain"></i>獲利</span>
        <span><i class="lg-loss"></i>虧損</span>
        <span><i class="lg-pend"></i>未結算</span>
      </div>
    </div>
    <div id="day-detail"></div>`;

  $$('[data-month]', el).forEach(b => b.addEventListener('click', () => {
    let nm = m + Number(b.dataset.month);
    let ny = y;
    if (nm < 1) { nm = 12; ny--; }
    if (nm > 12) { nm = 1; ny++; }
    state.ym = { y: ny, m: nm };
    state.selected = null;
    renderCalendar(new URLSearchParams());
  }));

  $('[data-today]', el).addEventListener('click', () => {
    state.ym = ymOf(today);
    state.selected = today;
    renderCalendar(new URLSearchParams());
  });

  loadStocks().catch(() => {});

  try {
    const res = await apiRead('calendar', { year: y, month: m, includeEmpty: true });
    if (seq !== state.renderSeq) return;

    const data = res.data;
    const grid = $('#cal-grid');
    grid.classList.remove('is-loading-grid');
    grid.innerHTML = calendarCells(y, m, data.days, today);

    grid.addEventListener('click', e => {
      const cell = e.target.closest('[data-date]');
      if (!cell) return;
      state.selected = cell.dataset.date;
      $$('.cal-day.selected', grid).forEach(c => c.classList.remove('selected'));
      cell.classList.add('selected');
      renderDay(state.selected);
    });

    const s = data.summary;
    $('#cal-summary').innerHTML = `
      ${staleNote(res)}
      <div class="summary-strip">
        <div>
          <div class="kpi-label">本月損益</div>
          <div class="kpi-value lg ${signClass(s.totalProfit)}">${fmtMoney(s.totalProfit)}</div>
        </div>
        <div>
          <div class="kpi-label">判斷筆數</div>
          <div class="kpi-value">${s.totalJudgments}</div>
        </div>
        <div>
          <div class="kpi-label">盈／虧日</div>
          <div class="kpi-value"><span class="gain">${s.positiveDays}</span><span class="flat"> / </span><span class="loss">${s.negativeDays}</span></div>
        </div>
      </div>`;

    const inMonth = state.selected && state.selected.startsWith(`${y}-${pad2(m)}-`);
    const defaultDay = today.startsWith(`${y}-${pad2(m)}-`) ? today : null;
    const day = inMonth ? state.selected : defaultDay;

    if (day) {
      state.selected = day;
      const cell = $(`[data-date="${day}"]`, grid);
      if (cell) cell.classList.add('selected');
      renderDay(day);
    }
  } catch (err) {
    if (seq !== state.renderSeq) return;
    $('#cal-grid').classList.remove('is-loading-grid');
    $('#cal-summary').innerHTML = errorBlock(err);
    bindRetry(el);
  }
}

function calendarCells(y, m, days, today) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = {};
  (days || []).forEach(d => { byDate[d.date] = d; });

  const maxAbs = Math.max(1, ...(days || []).map(d => Math.abs(d.profit)));
  const cells = [];

  for (let i = 0; i < first; i++) cells.push('<div class="cal-day blank"></div>');

  for (let d = 1; d <= count; d++) {
    const date = `${y}-${pad2(m)}-${pad2(d)}`;
    const dow = (first + d - 1) % 7;
    const info = byDate[date];
    const cls = ['cal-day'];
    let inner = `<span class="d">${d}</span>`;

    if (dow === 0 || dow === 6) cls.push('weekend');
    if (date === today) cls.push('today');

    if (info && info.judgmentCount > 0) {
      cls.push('has-data');
      if (info.profitCount > 0) {
        const sc = signClass(info.profit);
        cls.push(sc);
        if (sc !== 'flat') {
          cls.push('l' + Math.max(1, Math.ceil((Math.abs(info.profit) / maxAbs) * 4)));
        }
        inner += `<span class="p ${sc === 'flat' ? 'flat' : ''}">${fmtCompact(info.profit)}</span>`;
      } else {
        cls.push('pending');
        inner += '<span class="p flat">未結</span>';
      }
      if (info.judgmentCount > 1) inner += `<span class="cnt">×${info.judgmentCount}</span>`;
    }

    const label = info && info.judgmentCount
      ? `${m}月${d}日，${info.judgmentCount} 筆判斷，損益 ${fmtMoney(info.profit)}`
      : `${m}月${d}日`;

    cells.push(`<button type="button" class="${cls.join(' ')}" data-date="${date}" aria-label="${esc(label)}">${inner}</button>`);
  }

  return cells.join('');
}

async function renderDay(date) {
  const box = $('#day-detail');
  if (!box) return;
  const seq = state.renderSeq;
  const pending = pendingForDate(date);

  box.innerHTML = `
    <div class="day-head">
      <h2><span class="num">${esc(date.slice(5).replace('-', '/'))}</span>（${weekdayOf(date)}）</h2>
      <span class="day-total num" id="day-total"></span>
    </div>
    <div class="skeleton"></div><div class="skeleton"></div>`;

  try {
    const res = await apiRead('calendar.day', { date, withStock: true });
    if (seq !== state.renderSeq || state.selected !== date) return;
    const d = res.data;

    const pendingNote = pending.length
      ? `<div class="callout warn" style="margin-bottom:8px"><p>此日有 ${pending.length} 筆離線紀錄尚未同步。</p></div>`
      : '';

    const list = d.judgments.length
      ? `<ul class="jlist">${d.judgments.map(j => judgmentItem(j)).join('')}</ul>`
      : `<div class="empty">這天還沒有判斷紀錄</div>`;

    box.innerHTML = `
      <div class="day-head">
        <h2><span class="num">${esc(date.slice(5).replace('-', '/'))}</span>（${weekdayOf(date)}）</h2>
        <span class="day-total num">${d.profitCount ? `<span class="${signClass(d.profit)}">${fmtMoney(d.profit)}</span>` : ''}</span>
      </div>
      ${staleNote(res)}
      ${pendingNote}
      ${list}
      <a class="btn btn-block section-gap" href="#entry?date=${date}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        新增這天的判斷
      </a>`;
  } catch (err) {
    if (seq !== state.renderSeq) return;
    box.innerHTML = errorBlock(err);
    bindRetry(box);
  }
}


/* ============================================================
 * 新增／編輯判斷
 * ============================================================ */

async function renderEntry(params) {
  const el = $('#view-entry');
  const editDate = params.get('date');
  const editCode = params.get('code');
  const isEdit = !!(editDate && editCode);
  const seq = ++state.renderSeq;

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">${isEdit ? '編輯判斷' : '新增判斷'}</h1>
        <p class="view-sub">${isEdit ? '日期與股票代號為識別鍵，無法修改' : '同一天同一檔股票會更新為同一筆紀錄'}</p>
      </div>
    </div>
    <form id="judgment-form" class="card card-pad" novalidate>
      <div class="grid-2">
        <div class="field">
          <label for="jf-date">日期</label>
          <input id="jf-date" name="date" type="date" required value="${esc(editDate || todayTaipei())}" ${isEdit ? 'readonly' : ''}>
        </div>
        <div class="field">
          <label for="jf-code">股票代號</label>
          <input id="jf-code" name="code" list="stock-options" required maxlength="20" autocomplete="off"
            placeholder="2330" value="${esc(editCode || '')}" ${isEdit ? 'readonly' : ''}>
          <datalist id="stock-options"></datalist>
        </div>
      </div>
      <p class="help" id="jf-stock-name" style="margin-top:-8px"></p>

      <div class="field">
        <span id="jf-dir-label" style="font-size:13px;font-weight:500;color:var(--ink-2)">判斷方向</span>
        <div class="segmented" role="radiogroup" aria-labelledby="jf-dir-label">
          ${DIRECTIONS.map((d, i) => `
            <input type="radio" name="direction" id="jf-dir-${i}" value="${d}">
            <label for="jf-dir-${i}" class="${['seg-long', 'seg-short', 'seg-neutral'][i]}">${d}</label>`).join('')}
        </div>
      </div>

      <div class="field">
        <label for="jf-reason">判斷理由</label>
        <textarea id="jf-reason" name="reason" maxlength="5000" required placeholder="技術面、籌碼面、消息面…"></textarea>
      </div>

      <div class="grid-2">
        <div class="field">
          <label for="jf-today">當日盤後</label>
          <input id="jf-today" name="todayAfter" class="num-input" inputmode="decimal" autocomplete="off" placeholder="收盤價">
        </div>
        <div class="field">
          <label for="jf-next">次日盤後</label>
          <input id="jf-next" name="nextDayAfter" class="num-input" inputmode="decimal" autocomplete="off" placeholder="可之後補填">
        </div>
      </div>

      <div class="field">
        <label for="jf-profit">損益 <small>留空代表尚未結算</small></label>
        <input id="jf-profit" name="profit" class="num-input" inputmode="decimal" autocomplete="off" placeholder="例如 1000 或 -500">
      </div>

      <details class="calc">
        <summary>依價差試算損益</summary>
        <div class="grid-2">
          <div class="field" style="margin-bottom:8px">
            <label for="calc-shares">股數</label>
            <input id="calc-shares" class="num-input" inputmode="numeric" value="1000">
          </div>
          <div class="field" style="margin-bottom:8px;align-self:end">
            <label class="check"><input type="checkbox" id="calc-cost" checked>扣除手續費與證交稅</label>
          </div>
        </div>
        <button type="button" class="btn btn-sm" id="calc-run">試算並填入</button>
        <p class="calc-note">看多以當日盤後買進、次日盤後賣出；看空相反。手續費 0.1425%（每筆最低 20 元）、證交稅 0.3%，未計券商折扣與當沖減半，僅供參考。</p>
      </details>

      <p class="form-error" id="jf-error" role="alert" hidden></p>

      <div class="form-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger-ghost" id="jf-delete">刪除</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" id="jf-cancel">取消</button>
        <button type="submit" class="btn btn-primary" id="jf-submit">儲存</button>
      </div>
    </form>`;

  const form = $('#judgment-form');
  const codeInput = $('#jf-code');

  const showName = () => {
    const name = stockName(codeInput.value.trim().toUpperCase());
    $('#jf-stock-name').textContent = name ? name : '';
  };

  loadStocks().then(stocks => {
    if (seq !== state.renderSeq) return;
    $('#stock-options').innerHTML = stocks.map(s => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join('');
    showName();
  }).catch(() => {});

  codeInput.addEventListener('input', showName);

  $('#jf-cancel').addEventListener('click', () => history.length > 1 ? history.back() : navigate('#calendar'));
  $('#calc-run').addEventListener('click', () => runCalculator(form));

  if (isEdit) {
    const submit = $('#jf-submit');
    setLoading(submit, true);
    try {
      const { data } = await apiRead('judgment.get', { date: editDate, code: editCode });
      if (seq !== state.renderSeq) return;
      fillJudgmentForm(form, data);
    } catch (err) {
      if (seq !== state.renderSeq) return;
      if (err.code === 'not_found') {
        const pending = getQueue().find(q => q.date === editDate && q.code === editCode);
        if (pending) fillJudgmentForm(form, pending);
        else showFormError('#jf-error', '找不到這筆紀錄，可能已被刪除');
      } else {
        showFormError('#jf-error', err.message);
      }
    } finally {
      setLoading(submit, false);
    }

    $('#jf-delete').addEventListener('click', () => deleteJudgment(editDate, editCode));
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    saveJudgment(form, isEdit);
  });
}

function fillJudgmentForm(form, j) {
  const radio = $$('input[name="direction"]', form).find(r => r.value === j.direction);
  if (radio) radio.checked = true;
  form.reason.value = j.reason || '';
  form.todayAfter.value = j.todayAfter === null || j.todayAfter === undefined ? '' : j.todayAfter;
  form.nextDayAfter.value = j.nextDayAfter === null || j.nextDayAfter === undefined ? '' : j.nextDayAfter;
  form.profit.value = j.profit === null || j.profit === undefined ? '' : j.profit;
}

function parseNumberField(value, label) {
  const text = String(value).replace(/[,\s]/g, '');
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(label + ' 必須是數字');
  return n;
}

function showFormError(sel, message) {
  const el = $(sel);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function readJudgmentForm(form) {
  const date = form.date.value;
  const code = form.code.value.trim().toUpperCase();
  const dirInput = $('input[name="direction"]:checked', form);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('請選擇日期');
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(code)) throw new Error('股票代號格式不正確');
  if (!dirInput) throw new Error('請選擇判斷方向');
  if (!form.reason.value.trim()) throw new Error('請填寫判斷理由');

  return {
    date,
    code,
    direction: dirInput.value,
    reason: form.reason.value.trim(),
    todayAfter: parseNumberField(form.todayAfter.value, '當日盤後'),
    nextDayAfter: parseNumberField(form.nextDayAfter.value, '次日盤後'),
    profit: parseNumberField(form.profit.value, '損益')
  };
}

async function saveJudgment(form, isEdit) {
  const submit = $('#jf-submit');
  showFormError('#jf-error', '');

  let payload;
  try {
    payload = readJudgmentForm(form);
  } catch (err) {
    showFormError('#jf-error', err.message);
    return;
  }

  setLoading(submit, true);

  try {
    const res = await api('judgment.save', payload);
    toast(res.action === 'created' ? '已新增判斷' : '已更新判斷');
    state.selected = payload.date;
    state.ym = ymOf(payload.date);
    navigate('#calendar');
  } catch (err) {
    if (err.code === 'network') {
      enqueue(payload);
      toast('目前離線，已暫存，恢復連線後自動同步');
      state.selected = payload.date;
      state.ym = ymOf(payload.date);
      navigate('#calendar');
    } else {
      showFormError('#jf-error', err.message);
    }
  } finally {
    setLoading(submit, false);
  }
}

async function deleteJudgment(date, code) {
  if (!confirm(`確定刪除 ${date} ${code} 的判斷紀錄？此動作無法復原。`)) return;

  const btn = $('#jf-delete');
  setLoading(btn, true);

  try {
    await api('judgment.delete', { date, code });
    // 一併移除同鍵的離線暫存
    persist(LS.queue, getQueue().filter(q => !(q.date === date && q.code === code)));
    updateStatus();
    toast('已刪除');
    state.selected = date;
    navigate('#calendar');
  } catch (err) {
    showFormError('#jf-error', err.message);
  } finally {
    setLoading(btn, false);
  }
}

/**
 * 依價差試算（台股一般交易）：
 * 看多：當日盤後買進、次日盤後賣出
 * 看空：當日盤後賣出、次日盤後買回
 */
function runCalculator(form) {
  try {
    const dirInput = $('input[name="direction"]:checked', form);
    if (!dirInput || dirInput.value === '中性') throw new Error('試算需要先選擇看多或看空');

    const p0 = parseNumberField(form.todayAfter.value, '當日盤後');
    const p1 = parseNumberField(form.nextDayAfter.value, '次日盤後');
    const shares = parseNumberField($('#calc-shares').value, '股數');
    if (p0 === null || p1 === null) throw new Error('請先填寫當日與次日盤後價格');
    if (!shares || shares <= 0) throw new Error('股數必須大於 0');

    const long = dirInput.value === '看多';
    const buy = long ? p0 : p1;
    const sell = long ? p1 : p0;
    let profit = (sell - buy) * shares;

    if ($('#calc-cost').checked) {
      const fee = v => Math.max(20, Math.floor(v * shares * 0.001425));
      const tax = Math.floor(sell * shares * 0.003);
      profit -= fee(buy) + fee(sell) + tax;
    }

    form.profit.value = Math.round(profit);
    showFormError('#jf-error', '');
    toast('已填入試算損益 ' + fmtMoney(Math.round(profit)));
  } catch (err) {
    showFormError('#jf-error', err.message);
  }
}


/* ============================================================
 * 判斷紀錄
 * ============================================================ */

async function renderRecords() {
  const el = $('#view-records');
  const seq = ++state.renderSeq;
  const f = state.records.filters;

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">判斷紀錄</h1>
        <p class="view-sub" id="rec-count">　</p>
      </div>
    </div>
    <form class="card filters" id="rec-filters">
      <div class="row">
        <div class="field">
          <label for="rf-start">起日</label>
          <input id="rf-start" name="startDate" type="date" value="${esc(f.startDate || '')}">
        </div>
        <div class="field">
          <label for="rf-end">迄日</label>
          <input id="rf-end" name="endDate" type="date" value="${esc(f.endDate || '')}">
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="rf-code">股票代號</label>
          <input id="rf-code" name="code" maxlength="20" autocomplete="off" value="${esc(f.code || '')}">
        </div>
        <div class="field">
          <label for="rf-dir">判斷方向</label>
          <select id="rf-dir" name="direction">
            <option value="">全部</option>
            ${DIRECTIONS.map(d => `<option ${f.direction === d ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="rf-kw">理由關鍵字</label>
        <input id="rf-kw" name="keyword" type="search" autocomplete="off" value="${esc(f.keyword || '')}">
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="rf-reset">清除</button>
        <span class="spacer"></span>
        <button type="submit" class="btn btn-primary btn-sm">套用篩選</button>
      </div>
    </form>
    <div id="rec-list"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;

  $('#rec-filters').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const filters = {};
    for (const [k, v] of fd.entries()) {
      const val = String(v).trim();
      if (val) filters[k] = k === 'code' ? val.toUpperCase() : val;
    }
    state.records = { page: 1, filters };
    renderRecords();
  });

  $('#rf-reset').addEventListener('click', () => {
    state.records = { page: 1, filters: {} };
    renderRecords();
  });

  try {
    const res = await apiRead('judgments', Object.assign({}, f, {
      page: state.records.page, pageSize: 30, withStock: true
    }));
    if (seq !== state.renderSeq) return;

    const { items, pagination: pg } = res.data;
    $('#rec-count').textContent = `共 ${pg.total} 筆`;

    $('#rec-list').innerHTML = `
      ${staleNote(res)}
      ${items.length
        ? `<ul class="jlist">${items.map(j => judgmentItem(j, { showDate: true })).join('')}</ul>`
        : '<div class="empty">沒有符合條件的紀錄</div>'}
      ${pg.totalPages > 1 ? `
        <div class="pager">
          <button class="btn btn-sm" type="button" data-page="-1" ${pg.page <= 1 ? 'disabled' : ''}>上一頁</button>
          <span class="num">${pg.page} / ${pg.totalPages}</span>
          <button class="btn btn-sm" type="button" data-page="1" ${pg.page >= pg.totalPages ? 'disabled' : ''}>下一頁</button>
        </div>` : ''}`;

    $$('[data-page]', el).forEach(b => b.addEventListener('click', () => {
      state.records.page += Number(b.dataset.page);
      renderRecords();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
  } catch (err) {
    if (seq !== state.renderSeq) return;
    $('#rec-list').innerHTML = errorBlock(err);
    bindRetry(el);
  }
}


/* ============================================================
 * 股票資料
 * ============================================================ */

async function renderStocks() {
  const el = $('#view-stocks');
  const seq = ++state.renderSeq;

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">股票資料</h1>
        <p class="view-sub" id="stock-count">　</p>
      </div>
      <button class="btn btn-primary btn-sm" type="button" id="stock-add">
        <svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><path d="M12 5v14M5 12h14"/></svg>
        新增
      </button>
    </div>
    <div class="field">
      <label for="stock-search" class="sr-only">搜尋股票</label>
      <input id="stock-search" type="search" placeholder="搜尋代號、名稱、業務或標籤" autocomplete="off">
    </div>
    <div id="stock-list"><div class="skeleton"></div><div class="skeleton"></div></div>`;

  $('#stock-add').addEventListener('click', () => openStockDialog(null));

  try {
    const stocks = await loadStocks(true);
    if (seq !== state.renderSeq) return;

    const paint = q => {
      const kw = q.trim().toLowerCase();
      const list = kw
        ? stocks.filter(s => [s.code, s.name, s.business, s.tags, s.market].join(' ').toLowerCase().includes(kw))
        : stocks;

      $('#stock-count').textContent = `共 ${stocks.length} 檔`;
      $('#stock-list').innerHTML = list.length
        ? `<ul class="stock-list">${list.map(s => `
            <li>
              <button class="stock-item" type="button" data-code="${esc(s.code)}">
                <span class="code">${esc(s.code)}</span>
                <span class="name">${esc(s.name)}</span>
                <span class="market">${esc(s.market)}</span>
                ${s.business ? `<span class="meta">${esc(s.business)}</span>` : ''}
                ${s.tagList && s.tagList.length ? `<span class="tags">${s.tagList.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}
              </button>
            </li>`).join('')}</ul>`
        : `<div class="empty">${kw ? '找不到符合的股票' : '尚未建立股票資料'}</div>`;
    };

    paint('');
    $('#stock-search').addEventListener('input', e => paint(e.target.value));
    $('#stock-list').addEventListener('click', e => {
      const btn = e.target.closest('[data-code]');
      if (btn) openStockDialog(stocks.find(s => s.code === btn.dataset.code));
    });
  } catch (err) {
    if (seq !== state.renderSeq) return;
    $('#stock-list').innerHTML = errorBlock(err);
    bindRetry(el);
  }
}

function openStockDialog(stock) {
  const dlg = $('#stock-dialog');
  const form = $('#stock-form');
  const isEdit = !!stock;

  form.reset();
  showFormError('#stock-form-error', '');
  $('#stock-dialog-title').textContent = isEdit ? '編輯股票' : '新增股票';
  $('#stock-delete').hidden = !isEdit;
  form.code.readOnly = isEdit;

  if (isEdit) {
    form.code.value = stock.code;
    form.name.value = stock.name;
    form.market.value = stock.market;
    form.business.value = stock.business;
    form.tags.value = stock.tags;
  }

  dlg.dataset.mode = isEdit ? 'edit' : 'create';
  dlg.showModal();
  (isEdit ? form.name : form.code).focus();
}

function initStockDialog() {
  const dlg = $('#stock-dialog');
  const form = $('#stock-form');

  $$('[data-close]', dlg).forEach(b => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const submit = $('button[type="submit"]', form);
    const code = form.code.value.trim().toUpperCase();

    if (!/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(code)) {
      showFormError('#stock-form-error', '股票代號格式不正確');
      return;
    }
    if (!form.name.value.trim()) {
      showFormError('#stock-form-error', '請填寫股票名稱');
      return;
    }

    setLoading(submit, true);
    try {
      const res = await api('stock.save', {
        code,
        name: form.name.value.trim(),
        market: form.market.value.trim(),
        business: form.business.value.trim(),
        tags: form.tags.value
      });
      dlg.close();
      toast(res.action === 'created' ? '已新增股票' : '已更新股票');
      state.stocks = null;
      route();
    } catch (err) {
      showFormError('#stock-form-error', err.message);
    } finally {
      setLoading(submit, false);
    }
  });

  $('#stock-delete').addEventListener('click', async () => {
    const code = form.code.value;
    if (!confirm(`確定刪除股票 ${code}？歷史判斷紀錄會保留。`)) return;
    const btn = $('#stock-delete');
    setLoading(btn, true);
    try {
      const res = await api('stock.delete', { code });
      dlg.close();
      toast(res.remainingJudgments ? `已刪除，仍有 ${res.remainingJudgments} 筆判斷使用此代號` : '已刪除');
      state.stocks = null;
      route();
    } catch (err) {
      showFormError('#stock-form-error', err.message);
    } finally {
      setLoading(btn, false);
    }
  });
}


/* ============================================================
 * 統計
 * ============================================================ */

function statsRange(key) {
  const today = todayTaipei();
  const { y, m } = ymOf(today);
  switch (key) {
    case 'month': return { startDate: `${y}-${pad2(m)}-01`, endDate: today, label: '本月' };
    case '90d': return { startDate: addDays(today, -89), endDate: today, label: '近 90 天' };
    case 'year': return { startDate: `${y}-01-01`, endDate: today, label: '今年' };
    default: return { startDate: null, endDate: null, label: '全部' };
  }
}

async function renderStats() {
  const el = $('#view-stats');
  const seq = ++state.renderSeq;
  const range = statsRange(state.statsRange);
  const params = {};
  if (range.startDate) params.startDate = range.startDate;
  if (range.endDate) params.endDate = range.endDate;

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">統計</h1>
        <p class="view-sub">${range.startDate ? `${range.startDate} ～ ${range.endDate}` : '全部期間'}</p>
      </div>
    </div>
    <div class="chip-row" role="group" aria-label="期間">
      ${[['month', '本月'], ['90d', '近 90 天'], ['year', '今年'], ['all', '全部']].map(([k, l]) =>
        `<button type="button" class="chip" data-range="${k}" aria-pressed="${state.statsRange === k}">${l}</button>`).join('')}
    </div>
    <div id="stats-body" class="section-gap"><div class="skeleton" style="height:140px"></div><div class="skeleton" style="height:180px"></div></div>`;

  $$('[data-range]', el).forEach(b => b.addEventListener('click', () => {
    state.statsRange = b.dataset.range;
    renderStats();
  }));

  try {
    const [statsRes, series] = await Promise.all([
      apiRead('statistics', params),
      loadSeries(params)
    ]);
    if (seq !== state.renderSeq) return;

    const s = statsRes.data;
    const dirRows = DIRECTIONS
      .filter(d => s.byDirection[d])
      .map(d => [d, s.byDirection[d]]);

    $('#stats-body').innerHTML = `
      ${staleNote(statsRes)}
      <div class="kpi-grid">
        <div class="wide">
          <div class="kpi-label">累計損益</div>
          <div class="kpi-value lg ${signClass(s.totalProfit)}">${fmtMoney(s.totalProfit)}</div>
          <div class="kpi-sub">已結算 ${s.profitCount} 筆・未結算 ${s.unsettledCount} 筆</div>
        </div>
        <div>
          <div class="kpi-label">勝率</div>
          <div class="kpi-value">${fmtPct(s.winRate)}</div>
          <div class="kpi-sub"><span class="gain">${s.positiveCount} 勝</span>・<span class="loss">${s.negativeCount} 敗</span>${s.zeroCount ? `・${s.zeroCount} 平` : ''}</div>
        </div>
        <div>
          <div class="kpi-label">獲利因子</div>
          <div class="kpi-value">${s.profitFactor === null ? '—' : s.profitFactor.toFixed(2)}</div>
          <div class="kpi-sub">總獲利 ÷ 總虧損</div>
        </div>
        <div>
          <div class="kpi-label">平均獲利</div>
          <div class="kpi-value gain">${fmtMoney(s.averageWin, { round: true })}</div>
        </div>
        <div>
          <div class="kpi-label">平均虧損</div>
          <div class="kpi-value loss">${fmtMoney(s.averageLoss, { round: true })}</div>
        </div>
        <div>
          <div class="kpi-label">單筆最大獲利</div>
          <div class="kpi-value ${signClass(s.maxProfit)}">${fmtMoney(s.maxProfit)}</div>
        </div>
        <div>
          <div class="kpi-label">單筆最大虧損</div>
          <div class="kpi-value ${signClass(s.maxLoss)}">${fmtMoney(s.maxLoss)}</div>
        </div>
      </div>

      <p class="section-label">累計損益走勢</p>
      <div class="card chart-card">
        ${cumulativeChart(series)}
      </div>

      <p class="section-label">依判斷方向</p>
      <div class="card table-wrap">
        ${dirRows.length ? `
          <table class="dir-table">
            <thead><tr><th>方向</th><th>筆數</th><th>勝率</th><th>損益</th><th>平均</th></tr></thead>
            <tbody>
              ${dirRows.map(([d, a]) => `
                <tr>
                  <td><span class="dir ${DIR_CLASS[d]}">${d}</span></td>
                  <td class="num">${a.profitCount}<span class="flat">/${a.judgmentCount}</span></td>
                  <td class="num">${fmtPct(a.winRate)}</td>
                  <td class="num ${signClass(a.totalProfit)}">${fmtMoney(a.totalProfit)}</td>
                  <td class="num ${signClass(a.averageProfit)}">${fmtMoney(a.averageProfit, { round: true })}</td>
                </tr>`).join('')}
            </tbody>
          </table>` : '<div class="empty" style="border:0">此期間沒有紀錄</div>'}
      </div>`;
  } catch (err) {
    if (seq !== state.renderSeq) return;
    $('#stats-body').innerHTML = errorBlock(err);
    bindRetry(el);
  }
}

/** 取期間內的判斷紀錄，彙總成每日損益 */
async function loadSeries(params) {
  const byDate = {};
  let page = 1;
  let totalPages = 1;

  do {
    const { data } = await apiRead('judgments', Object.assign({}, params, { page, pageSize: 200 }));
    data.items.forEach(j => {
      if (j.profit === null) return;
      byDate[j.date] = (byDate[j.date] || 0) + j.profit;
    });
    totalPages = data.pagination.totalPages;
    page++;
  } while (page <= totalPages && page <= 10);

  let cum = 0;
  return Object.keys(byDate).sort().map(date => {
    cum += byDate[date];
    return { date, value: Math.round(cum * 100) / 100 };
  });
}

function cumulativeChart(series) {
  if (series.length < 2) {
    return '<div class="empty" style="border:0">至少需要兩天已結算的紀錄才能繪製走勢</div>';
  }

  const W = 340, H = 160, padL = 4, padR = 4, padT = 16, padB = 22;
  const values = series.map(p => p.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;

  const x = i => padL + (i / (series.length - 1)) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / span) * (H - padT - padB);

  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  const last = series[series.length - 1];
  const tone = last.value >= 0 ? 'var(--gain)' : 'var(--loss)';
  const zeroY = y(0).toFixed(1);

  const peak = values.indexOf(max);
  const trough = values.indexOf(min);

  return `
    <div class="chart-head">
      <h3>${series.length} 個交易日</h3>
      <span class="num ${signClass(last.value)}" style="font-weight:600">${fmtMoney(last.value)}</span>
    </div>
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="累計損益由 ${esc(series[0].date)} 至 ${esc(last.date)}，最終 ${esc(fmtMoney(last.value))}">
        <line class="axis" x1="${padL}" x2="${W - padR}" y1="${zeroY}" y2="${zeroY}"/>
        <polygon class="area" fill="${tone}" points="${x(0).toFixed(1)},${zeroY} ${pts.join(' ')} ${x(series.length - 1).toFixed(1)},${zeroY}"/>
        <polyline class="line" stroke="${tone}" points="${pts.join(' ')}"/>
        ${max > 0 && peak !== series.length - 1 ? `<text x="${x(peak).toFixed(1)}" y="${(y(max) - 6).toFixed(1)}" text-anchor="middle">${esc(fmtCompact(max, { plus: true }))}</text>` : ''}
        ${min < 0 && trough !== series.length - 1 ? `<text x="${x(trough).toFixed(1)}" y="${(y(min) + 14).toFixed(1)}" text-anchor="middle">${esc(fmtCompact(min, { plus: true }))}</text>` : ''}
        <circle class="dot" cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="4.5" fill="${tone}"/>
        <text x="${padL}" y="${H - 4}">${esc(series[0].date.slice(5))}</text>
        <text x="${W - padR}" y="${H - 4}" text-anchor="end">${esc(last.date.slice(5))}</text>
      </svg>
    </div>`;
}


/* ============================================================
 * 設定
 * ============================================================ */

function renderSettings() {
  const el = $('#view-settings');
  ++state.renderSeq;
  const cfg = getConfig();
  const prefs = getPrefs();
  const queue = getQueue();
  const preset = (window.APP_CONFIG && window.APP_CONFIG.apiUrl) || '';

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1 class="view-title">設定</h1>
        <p class="view-sub">設定只儲存在這台裝置的瀏覽器中</p>
      </div>
    </div>

    <form class="card settings-group" id="cfg-form" novalidate>
      <h2>後端連線</h2>
      <div class="field">
        <label for="cfg-url">API 網址</label>
        <input id="cfg-url" name="apiUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false"
          placeholder="https://script.google.com/macros/s/…/exec" value="${esc(load(LS.config, {}).apiUrl || '')}">
      </div>
      ${preset ? `<p class="help">未填寫時使用 config.js 的預設網址。</p>` : ''}
      <div class="field">
        <label for="cfg-token">API Token <small>後端未啟用可留空</small></label>
        <div class="pw-wrap">
          <input id="cfg-token" name="token" type="password" autocomplete="off" spellcheck="false" value="${esc(cfg.token)}">
          <button type="button" class="btn btn-ghost btn-sm" id="cfg-token-toggle">顯示</button>
        </div>
      </div>
      <p class="help">Token 不會寫進程式碼或 GitHub，只存在本機。共用電腦請勿儲存。</p>
      <p class="form-error" id="cfg-error" role="alert" hidden></p>
      <div class="inline-actions">
        <button type="submit" class="btn btn-primary">儲存</button>
        <button type="button" class="btn" id="cfg-test">測試連線</button>
      </div>
      <div id="cfg-result" class="section-gap" hidden></div>
    </form>

    <div class="card settings-group">
      <h2>顯示</h2>
      <div class="field">
        <label for="pref-colors">漲跌顏色</label>
        <select id="pref-colors">
          <option value="tw" ${prefs.colors === 'tw' ? 'selected' : ''}>台股慣例：紅漲綠跌</option>
          <option value="intl" ${prefs.colors === 'intl' ? 'selected' : ''}>國際慣例：綠漲紅跌</option>
        </select>
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="pref-theme">外觀</label>
        <select id="pref-theme">
          <option value="system" ${prefs.theme === 'system' ? 'selected' : ''}>跟隨系統</option>
          <option value="light" ${prefs.theme === 'light' ? 'selected' : ''}>淺色</option>
          <option value="dark" ${prefs.theme === 'dark' ? 'selected' : ''}>深色</option>
        </select>
      </div>
    </div>

    <div class="card settings-group">
      <h2>離線與快取</h2>
      <div class="kv"><span>待同步紀錄</span><span class="num">${queue.length} 筆</span></div>
      <div class="kv"><span>本機快取</span><span class="num">${Object.keys(load(LS.cache, {})).length} 項</span></div>
      <div class="inline-actions section-gap">
        <button type="button" class="btn btn-sm" id="q-sync" ${queue.length ? '' : 'disabled'}>立即同步</button>
        <button type="button" class="btn btn-sm btn-danger-ghost" id="q-clear" ${queue.length ? '' : 'disabled'}>捨棄待同步</button>
        <button type="button" class="btn btn-sm btn-ghost" id="c-clear">清除快取</button>
      </div>
    </div>

    <div class="card settings-group">
      <h2>維護</h2>
      <p class="help" style="margin-top:0">直接在試算表手動修改資料後，可重建行事曆彙總表。</p>
      <div class="inline-actions">
        <button type="button" class="btn btn-sm" id="m-rebuild">重建行事曆</button>
        <button type="button" class="btn btn-sm btn-ghost" id="m-init">初始化資料表</button>
      </div>
      <div class="section-gap">
        <div class="kv"><span>前端版本</span><span class="num">${APP_VERSION}</span></div>
        <div class="kv"><span>後端版本</span><span class="num" id="backend-version">—</span></div>
      </div>
    </div>`;

  const form = $('#cfg-form');

  $('#cfg-token-toggle').addEventListener('click', e => {
    const input = $('#cfg-token');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.target.textContent = show ? '隱藏' : '顯示';
  });

  const saveConfig = () => {
    const url = form.apiUrl.value.trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(url) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
      showFormError('#cfg-error', '網址格式應為 https://script.google.com/macros/s/部署ID/exec');
      return false;
    }
    showFormError('#cfg-error', '');
    persist(LS.config, { apiUrl: url, token: form.token.value.trim() });
    state.stocks = null;
    return true;
  };

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (saveConfig()) toast('已儲存設定');
  });

  $('#cfg-test').addEventListener('click', async e => {
    if (!saveConfig()) return;
    const btn = e.currentTarget;
    const out = $('#cfg-result');
    setLoading(btn, true);
    out.hidden = false;
    out.innerHTML = '';
    try {
      const started = performance.now();
      const health = await api('health');
      await api('stocks', { page: 1, pageSize: 1 });
      const ms = Math.round(performance.now() - started);
      $('#backend-version').textContent = health.version;
      out.innerHTML = `<div class="callout"><h3 class="gain" style="color:var(--green)">連線成功</h3><p>後端 ${esc(health.service)} v${esc(health.version)}，往返 ${ms} ms，授權正常。</p></div>`;
    } catch (err) {
      out.innerHTML = `<div class="callout error"><h3>連線失敗</h3><p>${esc(err.message)}</p></div>`;
    } finally {
      setLoading(btn, false);
    }
  });

  $('#pref-colors').addEventListener('change', e => {
    persist(LS.prefs, Object.assign(getPrefs(), { colors: e.target.value }));
    applyPrefs();
  });
  $('#pref-theme').addEventListener('change', e => {
    persist(LS.prefs, Object.assign(getPrefs(), { theme: e.target.value }));
    applyPrefs();
  });

  $('#q-sync').addEventListener('click', () => syncQueue());
  $('#q-clear').addEventListener('click', () => {
    if (!confirm('確定捨棄所有尚未同步的紀錄？')) return;
    persist(LS.queue, []);
    updateStatus();
    renderSettings();
  });
  $('#c-clear').addEventListener('click', () => {
    persist(LS.cache, {});
    state.stocks = null;
    toast('已清除快取');
    renderSettings();
  });

  $('#m-rebuild').addEventListener('click', async e => {
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const r = await api('calendar.rebuild');
      toast(`已重建，共 ${r.days} 天`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  $('#m-init').addEventListener('click', async e => {
    if (!confirm('初始化會建立缺少的工作表並檢查欄位，不會刪除既有資料。繼續？')) return;
    const btn = e.currentTarget;
    setLoading(btn, true);
    try {
      const r = await api('init');
      toast(r.timezoneOk ? '初始化完成' : `初始化完成；專案時區為 ${r.timezone}，建議改為 Asia/Taipei`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  if (cfg.apiUrl) {
    api('health').then(h => {
      const v = $('#backend-version');
      if (v) v.textContent = h.version;
    }).catch(() => {});
  }
}


/* ============================================================
 * 路由
 * ============================================================ */

const VIEWS = {
  calendar: renderCalendar,
  records: renderRecords,
  entry: renderEntry,
  stocks: renderStocks,
  stats: renderStats,
  settings: renderSettings
};

function route() {
  const raw = location.hash.replace(/^#/, '');
  const [name, query] = raw.split('?');
  const view = VIEWS[name] ? name : (getConfig().apiUrl ? 'calendar' : 'settings');
  const params = new URLSearchParams(query || '');

  $$('.view').forEach(v => { v.hidden = v.dataset.view !== view; });
  $$('.tabbar a').forEach(a => {
    if (a.dataset.tab === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const titles = { calendar: '行事曆', records: '紀錄', entry: '新增判斷', stocks: '股票', stats: '統計', settings: '設定' };
  document.title = `${titles[view]}・盤後判斷簿`;

  if (view !== 'calendar' || !params.get('date')) window.scrollTo(0, 0);
  VIEWS[view](params);
}


/* ============================================================
 * 啟動
 * ============================================================ */

function init() {
  applyPrefs();
  initStockDialog();

  $('#status-chip').addEventListener('click', () => {
    if (getQueue().length) syncQueue();
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => { updateStatus(); syncQueue({ silent: true }); });
  window.addEventListener('offline', updateStatus);

  updateStatus();
  route();
  syncQueue({ silent: true });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
