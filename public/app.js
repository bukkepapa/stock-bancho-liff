'use strict';

/* ============================================================
   ストック番長 LIFF版 — app.js
   LIFF + 品目カスタマイズ対応
   ============================================================ */

// ── LIFF設定 ──────────────────────────────────────────────
const LIFF_ID = '2009810063-dWZN49ly';

// ── 定数 ──────────────────────────────────────────────────
const DAY_NAMES   = ['日', '月', '火', '水', '木', '金', '土'];
const STORAGE_KEY = 'stockBanchoLiff_v1';

// ── デフォルト品目 ────────────────────────────────────────
// dailyAmount: 1日消費量（unit換算）
// purchaseAmount: 1回の購入量（unit換算）
// purchaseUnitName: 購入時の呼び名（省略時はunitと同じ）
// decimal: 小数点0.1刻み入力を使うか
const DEFAULT_ITEMS = [
  {
    id: 'egg',
    name: '卵',
    emoji: '🥚',
    unit: '個',
    dailyAmount: 4,
    purchaseAmount: 10,
    purchaseUnitName: 'ケース',
    decimal: false
  },
  {
    id: 'cheese',
    name: 'プロセスチーズ',
    emoji: '🧀',
    unit: '個',
    dailyAmount: 3,
    purchaseAmount: 4,
    purchaseUnitName: 'スリーブ',
    decimal: false
  },
  {
    id: 'coffee',
    name: 'アイスコーヒー',
    emoji: '☕',
    unit: '本',
    dailyAmount: 0.3333,   // 300ml/日 ÷ 900ml/本
    purchaseAmount: 1,
    purchaseUnitName: '本',
    decimal: true
  }
];

const DEFAULT_SETTINGS = {
  items: DEFAULT_ITEMS,
  shoppingDays: [1, 4],
  notifyHour: 20,
  notifyMinute: 0
};

// ── アプリ状態 ────────────────────────────────────────────
let state = {
  settings:     null,
  inventory:    null,
  purchaseLogs: []
};

let lineProfile  = null;  // { userId, displayName, pictureUrl }
let liffReady    = false;

let updateCounts    = {};
let updatePurchased = {};
let lastSuggestion  = null;
let editingItemId   = null;

// ── ストレージ ────────────────────────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.settings     = deepCopy(DEFAULT_SETTINGS);
      state.inventory    = buildDefaultInventory(DEFAULT_SETTINGS.items);
      state.purchaseLogs = [];
      return;
    }
    const data         = JSON.parse(raw);
    state.settings     = data.settings     || deepCopy(DEFAULT_SETTINGS);
    state.inventory    = data.inventory    || buildDefaultInventory(state.settings.items);
    state.purchaseLogs = data.purchaseLogs || [];
    ensureInventoryItems();
  } catch (e) {
    console.error('loadState error:', e);
    state.settings     = deepCopy(DEFAULT_SETTINGS);
    state.inventory    = buildDefaultInventory(DEFAULT_SETTINGS.items);
    state.purchaseLogs = [];
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    settings:     state.settings,
    inventory:    state.inventory,
    purchaseLogs: state.purchaseLogs
  }));
}

function buildDefaultInventory(items) {
  const inv = {};
  items.forEach(item => {
    inv[item.id] = { count: 0, unit: item.unit, updatedAt: null };
  });
  return inv;
}

function ensureInventoryItems() {
  state.settings.items.forEach(item => {
    if (!state.inventory[item.id]) {
      state.inventory[item.id] = { count: 0, unit: item.unit, updatedAt: null };
    }
  });
}

function deepCopy(obj)  { return JSON.parse(JSON.stringify(obj)); }
function generateId()   { return 'item_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── LIFF初期化 ────────────────────────────────────────────
async function initLiff() {
  try {
    await liff.init({ liffId: LIFF_ID });
    liffReady = true;

    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return false;  // ログインページにリダイレクト
    }

    lineProfile = await liff.getProfile();
    return true;
  } catch (e) {
    console.warn('LIFF init failed (graceful degradation):', e);
    liffReady = false;
    return true;  // LIFF失敗でもアプリは動かす
  }
}

// ── コアロジック ──────────────────────────────────────────
function getStockDays(item, count) {
  if (!item.dailyAmount || item.dailyAmount <= 0) return 0;
  return count / item.dailyAmount;
}

function getNextShoppingInfo(shoppingDays) {
  const today = new Date().getDay();
  const candidates = shoppingDays
    .map(day => ({ day, diff: (day - today + 7) % 7 }))
    .filter(x => x.diff > 0)
    .sort((a, b) => a.diff - b.diff);

  if (candidates.length > 0) {
    const { day, diff } = candidates[0];
    return { dayIndex: day, daysUntil: diff, dayName: DAY_NAMES[day] };
  }
  const firstDay = [...shoppingDays].sort((a, b) => a - b)[0];
  return { dayIndex: firstDay, daysUntil: 7, dayName: DAY_NAMES[firstDay] };
}

function isShoppingDay(shoppingDays) {
  return shoppingDays.includes(new Date().getDay());
}

function getStockStatus(stockDays, daysUntilShopping) {
  if (stockDays < daysUntilShopping)        return 'ALERT';
  if (stockDays < daysUntilShopping * 1.5) return 'WARNING';
  return 'OK';
}

function getSuggestedPurchase(item, currentCount, daysUntilNextShopping) {
  const needed   = item.dailyAmount * daysUntilNextShopping;
  const shortage = needed - currentCount;
  if (shortage <= 0) return { needed: false, unitCount: 0, totalCount: 0 };
  const unitCount  = Math.ceil(shortage / item.purchaseAmount);
  const totalCount = unitCount * item.purchaseAmount;
  return { needed: true, unitCount, totalCount };
}

function formatSuggestionAmount(item, s) {
  if (!s.needed) return '購入不要 ✅';
  const { unitCount, totalCount } = s;
  if (item.purchaseUnitName === item.unit || item.purchaseAmount <= 1) {
    return `${unitCount}${item.unit}`;
  }
  return `${unitCount}${item.purchaseUnitName}（${totalCount}${item.unit}）`;
}

// ── ナビゲーション ────────────────────────────────────────
let currentScreen = 'home';

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${screenId}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.screen === screenId);
  });
  currentScreen = screenId;
  switch (screenId) {
    case 'home':     renderHome();     break;
    case 'update':   renderUpdate();   break;
    case 'history':  renderHistory();  break;
    case 'settings': renderSettings(); break;
  }
  const content = document.querySelector(`#screen-${screenId} .screen-content`);
  if (content) content.scrollTop = 0;
}

// ── トースト ──────────────────────────────────────────────
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show${type === 'error' ? ' error' : ''}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ── ホーム ────────────────────────────────────────────────
function renderHome() {
  const { settings, inventory } = state;
  const { daysUntil, dayName } = getNextShoppingInfo(settings.shoppingDays);
  const todayIsShopping = isShoppingDay(settings.shoppingDays);
  const items = settings.items;

  // バッジ
  const badge = document.getElementById('shopping-day-badge');
  if (todayIsShopping) {
    badge.textContent = '🛒 今日が買い物日！';
    badge.className   = 'badge badge-today';
  } else {
    badge.textContent = `次：${dayName}曜（${daysUntil}日後）`;
    badge.className   = 'badge';
  }

  // ユーザー名
  const userEl = document.getElementById('user-display');
  if (userEl && lineProfile) {
    userEl.textContent = `👤 ${lineProfile.displayName}`;
    userEl.style.display = 'block';
  }

  // 在庫カード
  const alertNames = [];
  const cardsHTML = items.map(item => {
    const inv      = inventory[item.id] || { count: 0 };
    const count    = inv.count;
    const stockDays = getStockDays(item, count);
    const status   = getStockStatus(stockDays, daysUntil);
    if (status === 'ALERT') alertNames.push(item.name);

    const cfg = {
      OK:      { cssClass: 'card-ok',      badgeText: '🟢 余裕あり' },
      WARNING: { cssClass: 'card-warning', badgeText: '🟡 要注意'  },
      ALERT:   { cssClass: 'card-alert',   badgeText: '🔴 補充必要' }
    }[status];

    const countDisp = item.decimal ? Number(count).toFixed(1) : count;

    return `
      <div class="card ${cfg.cssClass}">
        <div class="card-header">
          <span class="card-emoji">${item.emoji}</span>
          <span class="card-name">${escapeHtml(item.name)}</span>
          <span class="card-status-badge">${cfg.badgeText}</span>
        </div>
        <div class="card-body">
          <span class="card-count">${countDisp} ${escapeHtml(item.unit)}</span>
          <span class="card-days">あと <strong>${stockDays.toFixed(1)}</strong> 日分</span>
        </div>
      </div>`;
  }).join('');

  document.getElementById('cards-container').innerHTML = cardsHTML;

  // アラートバナー
  const banner = document.getElementById('alert-banner');
  if (alertNames.length > 0) {
    const prefix = todayIsShopping ? '🛒 今日の買い物日！補充が必要：' : '⚠️ 次の買い物日前に切れます：';
    banner.textContent = `${prefix}${alertNames.join('、')}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // 最終更新
  const latestTs = Object.values(inventory)
    .map(v => v.updatedAt ? new Date(v.updatedAt).getTime() : 0)
    .reduce((a, b) => Math.max(a, b), 0);
  document.getElementById('last-updated').textContent = latestTs
    ? `最終更新：${formatDateTime(new Date(latestTs))}`
    : '在庫を更新してください';
}

// ── 更新画面 ──────────────────────────────────────────────
function renderUpdate() {
  const { settings, inventory } = state;
  const { daysUntil } = getNextShoppingInfo(settings.shoppingDays);
  const items = settings.items;

  items.forEach(item => {
    const inv = inventory[item.id] || { count: 0 };
    updateCounts[item.id]    = inv.count;
    updatePurchased[item.id] = 0;
  });

  const html = items.map(item => {
    const isDecimal = item.decimal;
    const count     = updateCounts[item.id];
    const stockDays = getStockDays(item, count);
    const status    = getStockStatus(stockDays, daysUntil);
    const statusCls = `status-${status.toLowerCase()}`;
    const countDisp = isDecimal ? Number(count).toFixed(1) : count;
    const stepAttr  = isDecimal ? '0.1' : '1';
    const modeAttr  = isDecimal ? 'decimal' : 'numeric';

    return `
      <div class="update-item">
        <div class="update-item-header">
          <span class="update-item-name">${item.emoji} ${escapeHtml(item.name)}</span>
          <span class="update-days-display ${statusCls}" id="days-${item.id}">
            あと ${stockDays.toFixed(1)} 日分
          </span>
        </div>
        <div class="update-row">
          <span class="update-row-label">現在の在庫</span>
          <div class="counter">
            <button class="counter-btn" onclick="changeCount('${item.id}', -1)" aria-label="減らす">−</button>
            <input type="number" id="count-${item.id}" value="${countDisp}" min="0"
                   step="${stepAttr}" inputmode="${modeAttr}" class="counter-input"
                   oninput="onCountInput('${item.id}')">
            <button class="counter-btn" onclick="changeCount('${item.id}', 1)" aria-label="増やす">＋</button>
          </div>
          <span class="counter-unit">${escapeHtml(item.unit)}</span>
        </div>
        <div class="update-row">
          <span class="update-row-label">今日購入した数<br><small class="text-muted text-sm">（任意）</small></span>
          <div class="counter">
            <button class="counter-btn" onclick="changePurchased('${item.id}', -1)" aria-label="減らす">−</button>
            <input type="number" id="purchased-${item.id}" value="${isDecimal ? '0.0' : '0'}" min="0"
                   step="${stepAttr}" inputmode="${modeAttr}" class="counter-input"
                   oninput="onPurchasedInput('${item.id}')">
            <button class="counter-btn" onclick="changePurchased('${item.id}', 1)" aria-label="増やす">＋</button>
          </div>
          <span class="counter-unit">${escapeHtml(item.unit)}</span>
        </div>
      </div>`;
  }).join('');

  document.getElementById('update-items-container').innerHTML = html;

  // メモ欄
  const todayStr  = new Date().toISOString().split('T')[0];
  const todayLog  = state.purchaseLogs.find(l => l.date === todayStr);
  const savedMemo = (todayLog && todayLog.memo) ? todayLog.memo : '';
  document.getElementById('update-memo-container').innerHTML = `
    <div class="memo-card">
      <label class="memo-label" for="update-memo">📝 メモ（任意）</label>
      <textarea id="update-memo" class="memo-textarea" rows="5"
        placeholder="今日の気づきや買い物メモなど自由に入力">${escapeHtml(savedMemo)}</textarea>
    </div>`;
}

function changeCount(itemId, delta) {
  const item   = state.settings.items.find(i => i.id === itemId);
  const input  = document.getElementById(`count-${itemId}`);
  const step   = (item && item.decimal) ? 0.1 : 1;
  const newVal = Math.max(0, Math.round(((updateCounts[itemId] || 0) + delta * step) * 10) / 10);
  updateCounts[itemId] = newVal;
  input.value = (item && item.decimal) ? newVal.toFixed(1) : newVal;
  refreshDaysDisplay(itemId);
}

function onCountInput(itemId) {
  const item  = state.settings.items.find(i => i.id === itemId);
  const input = document.getElementById(`count-${itemId}`);
  if (item && item.decimal) {
    const raw = parseFloat(input.value);
    const val = Math.max(0, isNaN(raw) ? 0 : Math.round(raw * 10) / 10);
    updateCounts[itemId] = val;
    if (isNaN(raw) || raw < 0) input.value = val.toFixed(1);
  } else {
    const val = Math.max(0, parseInt(input.value) || 0);
    updateCounts[itemId] = val;
    input.value = val;
  }
  refreshDaysDisplay(itemId);
}

function changePurchased(itemId, delta) {
  const item   = state.settings.items.find(i => i.id === itemId);
  const input  = document.getElementById(`purchased-${itemId}`);
  const step   = (item && item.decimal) ? 0.1 : 1;
  const newVal = Math.max(0, Math.round(((updatePurchased[itemId] || 0) + delta * step) * 10) / 10);
  updatePurchased[itemId] = newVal;
  input.value = (item && item.decimal) ? newVal.toFixed(1) : newVal;
}

function onPurchasedInput(itemId) {
  const item  = state.settings.items.find(i => i.id === itemId);
  const input = document.getElementById(`purchased-${itemId}`);
  if (item && item.decimal) {
    const raw = parseFloat(input.value);
    const val = Math.max(0, isNaN(raw) ? 0 : Math.round(raw * 10) / 10);
    updatePurchased[itemId] = val;
    if (isNaN(raw) || raw < 0) input.value = val.toFixed(1);
  } else {
    const val = Math.max(0, parseInt(input.value) || 0);
    updatePurchased[itemId] = val;
    input.value = val;
  }
}

function refreshDaysDisplay(itemId) {
  const el   = document.getElementById(`days-${itemId}`);
  const item = state.settings.items.find(i => i.id === itemId);
  if (!el || !item) return;
  const stockDays = getStockDays(item, updateCounts[itemId]);
  const { daysUntil } = getNextShoppingInfo(state.settings.shoppingDays);
  const status = getStockStatus(stockDays, daysUntil);
  el.textContent = `あと ${stockDays.toFixed(1)} 日分`;
  el.className   = `update-days-display status-${status.toLowerCase()}`;
}

// ── 保存処理 ──────────────────────────────────────────────
function handleSave() {
  const now   = new Date().toISOString();
  const today = now.split('T')[0];
  const items = state.settings.items;

  items.forEach(item => {
    if (!state.inventory[item.id]) {
      state.inventory[item.id] = { count: 0, unit: item.unit, updatedAt: null };
    }
    state.inventory[item.id].count     = updateCounts[item.id] || 0;
    state.inventory[item.id].updatedAt = now;
  });

  const memoEl = document.getElementById('update-memo');
  const memo   = memoEl ? memoEl.value.trim() : '';

  const wentShopping = items.some(item => (updatePurchased[item.id] || 0) > 0);
  state.purchaseLogs = state.purchaseLogs.filter(log => log.date !== today);

  const logEntry = { date: today, wentShopping, purchased: {}, memo };
  items.forEach(item => {
    logEntry.purchased[item.id] = { count: updatePurchased[item.id] || 0, unit: item.unit };
  });

  state.purchaseLogs.unshift(logEntry);
  state.purchaseLogs = state.purchaseLogs.slice(0, 30);

  saveState();
  showToast('✅ 在庫を保存しました');
  syncToServer();

  if (isShoppingDay(state.settings.shoppingDays)) {
    setTimeout(() => showSuggestionModal(), 600);
  } else {
    setTimeout(() => showScreen('home'), 800);
  }
}

// ── サジェストモーダル ────────────────────────────────────
function showSuggestionModal() {
  const { settings, inventory } = state;
  const { daysUntil, dayName } = getNextShoppingInfo(settings.shoppingDays);
  const items = settings.items;

  lastSuggestion = {};
  items.forEach(item => {
    const count = (inventory[item.id] || { count: 0 }).count;
    lastSuggestion[item.id] = getSuggestedPurchase(item, count, daysUntil);
  });

  const allNotNeeded = items.every(item => !lastSuggestion[item.id].needed);
  document.getElementById('suggestion-subtitle').textContent = `${dayName}曜まで（${daysUntil}日分）`;

  let itemsHTML;
  if (allNotNeeded) {
    itemsHTML = `<div class="suggestion-all-ok">🎉 今日は全アイテム購入不要です！</div>`;
  } else {
    itemsHTML = items.map(item => {
      const s      = lastSuggestion[item.id];
      const amount = formatSuggestionAmount(item, s);
      const rowCls = s.needed ? 'suggestion-needed' : 'suggestion-ok';
      return `
        <div class="suggestion-row ${rowCls}">
          <div class="suggestion-row-left">
            <span class="suggestion-row-emoji">${item.emoji}</span>
            <span class="suggestion-row-name">${escapeHtml(item.name)}</span>
          </div>
          <span class="suggestion-row-amount">${amount}</span>
        </div>`;
    }).join('');
  }
  document.getElementById('suggestion-items-container').innerHTML = itemsHTML;
  document.getElementById('modal-suggestion').classList.remove('hidden');
}

function closeSuggestion() {
  document.getElementById('modal-suggestion').classList.add('hidden');
  showScreen('home');
}

function buildShareText() {
  if (!lastSuggestion) return '';
  const { settings } = state;
  const { daysUntil, dayName } = getNextShoppingInfo(settings.shoppingDays);

  const lines = [
    '【ストック番長】今日の買い物メモ 🛒',
    `${dayName}曜まで（${daysUntil}日分）`,
    ''
  ];
  settings.items.forEach(item => {
    const s = lastSuggestion[item.id];
    if (s) lines.push(`${item.emoji} ${item.name}：${formatSuggestionAmount(item, s)}`);
  });
  lines.push('', '忘れずに！');

  const today    = new Date().toISOString().split('T')[0];
  const todayLog = state.purchaseLogs.find(l => l.date === today);
  if (todayLog && todayLog.memo) lines.push('', `📝 メモ：${todayLog.memo}`);

  return lines.join('\n');
}

function sendSuggestionToLINE() {
  const text = buildShareText();
  if (!text) return;

  // LIFF shareTargetPicker を優先使用（LINE内ブラウザのみ）
  if (liffReady && typeof liff !== 'undefined' &&
      liff.isApiAvailable && liff.isApiAvailable('shareTargetPicker')) {
    liff.shareTargetPicker([{ type: 'text', text }])
      .catch(() => window.open(`https://line.me/R/share?text=${encodeURIComponent(text)}`, '_blank'));
  } else {
    window.open(`https://line.me/R/share?text=${encodeURIComponent(text)}`, '_blank');
  }
}

// ── 履歴画面 ──────────────────────────────────────────────
function renderHistory() {
  const today = new Date();
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    return d.toISOString().split('T')[0];
  });

  const shoppingCount = last7.filter(date => {
    const log = state.purchaseLogs.find(l => l.date === date);
    return log && log.wentShopping;
  }).length;

  const pct   = Math.min(100, (shoppingCount / 2) * 100);
  const color = shoppingCount <= 2 ? 'var(--color-ok)' : 'var(--color-alert)';

  document.getElementById('weekly-summary-container').innerHTML = `
    <div class="weekly-card">
      <h3>今週のスーパー訪問（直近7日）</h3>
      <div class="weekly-stat">${shoppingCount} 回 <span class="text-muted text-sm">/ 目標 2 回</span></div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      ${shoppingCount <= 2
        ? `<p class="weekly-comment ok">✅ 目標達成中！すばらしい</p>`
        : `<p class="weekly-comment ng">⚠️ 目標より ${shoppingCount - 2} 回多いです</p>`}
    </div>`;

  const items = state.settings.items;
  document.getElementById('history-list-container').innerHTML = `
    <p class="history-section-title">直近 7 日間</p>
    <div class="history-list">
      ${last7.map(date => {
        const log = state.purchaseLogs.find(l => l.date === date);
        const d   = new Date(date + 'T00:00:00');
        const label = `${d.getMonth()+1}/${d.getDate()}（${DAY_NAMES[d.getDay()]}）`;

        if (!log) return `
          <div class="history-item no-data">
            <div class="history-item-header">
              <span class="history-date">${label}</span>
              <span class="text-muted text-sm">記録なし</span>
            </div>
          </div>`;

        const purchasedItems = items
          .filter(item => log.purchased && log.purchased[item.id] && log.purchased[item.id].count > 0)
          .map(item => {
            const cnt  = log.purchased[item.id].count;
            const disp = item.decimal ? Number(cnt).toFixed(1) : cnt;
            return `<span>${item.emoji} ${disp}${escapeHtml(item.unit)}</span>`;
          }).join('');

        return `
          <div class="history-item ${log.wentShopping ? 'went-shopping' : ''}">
            <div class="history-item-header">
              <span class="history-date">${label}</span>
              ${log.wentShopping ? '<span class="history-shopping-badge">🛒 買い物</span>' : ''}
            </div>
            ${purchasedItems ? `<div class="history-purchased">${purchasedItems}</div>` : ''}
            ${log.memo ? `<div class="history-memo">📝 ${escapeHtml(log.memo)}</div>` : ''}
          </div>`;
      }).join('')}
    </div>`;
}

// ── 設定画面 ──────────────────────────────────────────────
function renderSettings() {
  const s          = state.settings;
  const sliderVal  = s.notifyHour * 4 + Math.floor(s.notifyMinute / 15);
  const notifyDisp = `${String(s.notifyHour).padStart(2,'0')}:${String(s.notifyMinute).padStart(2,'0')}`;

  document.getElementById('settings-content').innerHTML = `

    <!-- 品目管理 -->
    <div class="settings-section">
      <h3>📦 品目の管理</h3>
      <div class="items-list">
        ${s.items.map(item => `
          <div class="item-row">
            <span class="item-row-emoji">${item.emoji}</span>
            <div class="item-row-info">
              <span class="item-row-name">${escapeHtml(item.name)}</span>
              <span class="item-row-detail">
                ${roundDisplay(item.dailyAmount)}${escapeHtml(item.unit)}/日・
                ${item.purchaseAmount}${escapeHtml(item.unit)}/${escapeHtml(item.purchaseUnitName)}
              </span>
            </div>
            <div class="item-row-actions">
              <button class="item-action-btn" onclick="showItemForm('${item.id}')" title="編集">✏️</button>
              <button class="item-action-btn item-delete-btn" onclick="deleteItem('${item.id}')" title="削除">🗑️</button>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn-add-item" onclick="showItemForm(null)">＋ 品目を追加する</button>
    </div>

    <!-- 買い物曜日 -->
    <div class="settings-section">
      <h3>🗓️ 買い物曜日</h3>
      <div class="day-selector">
        ${DAY_NAMES.map((day, i) => `
          <button class="day-btn ${s.shoppingDays.includes(i) ? 'active' : ''}"
                  data-day="${i}" onclick="toggleShoppingDay(${i})">${day}</button>
        `).join('')}
      </div>
    </div>

    <!-- 1日消費量の詳細調整 -->
    <div class="settings-section">
      <h3>📊 1日の消費量（詳細調整）</h3>
      ${s.items.map(item => `
        <div class="settings-row">
          <span class="settings-label">${item.emoji} ${escapeHtml(item.name)}</span>
          <div class="settings-control">
            <input type="number" id="daily-${item.id}"
                   value="${Math.round(item.dailyAmount * 10000) / 10000}"
                   min="0.001" step="0.001" inputmode="decimal" class="settings-input">
            <span class="settings-unit">${escapeHtml(item.unit)}/日</span>
          </div>
        </div>`).join('')}
    </div>

    <!-- LINE通知時刻 -->
    <div class="settings-section">
      <h3>🔔 LINE 通知時刻</h3>
      <div class="settings-row">
        <span class="settings-label">通知時刻</span>
        <div class="settings-control" style="gap:10px">
          <input type="range" id="notify-slider"
                 min="0" max="95" step="1" value="${sliderVal}"
                 class="notify-slider" oninput="updateNotifyDisplay()">
          <span class="notify-display" id="notify-display">${notifyDisp}</span>
        </div>
      </div>
    </div>

    <!-- LINEアカウント -->
    ${lineProfile ? `
    <div class="settings-section">
      <h3>👤 LINEアカウント</h3>
      <div class="line-account-row">
        ${lineProfile.pictureUrl
          ? `<img src="${lineProfile.pictureUrl}" class="line-avatar" alt="avatar">`
          : '<span class="line-avatar-placeholder">👤</span>'}
        <span class="line-display-name">${escapeHtml(lineProfile.displayName)}</span>
        <button class="btn-logout" onclick="handleLogout()">ログアウト</button>
      </div>
    </div>` : ''}

    <!-- ボタン -->
    <div class="settings-buttons">
      <button class="btn btn-primary btn-large" onclick="handleSettingsSave()">
        ✅ 設定を保存する
      </button>
      <button class="btn-reset" onclick="handleSettingsReset()">
        デフォルトに戻す
      </button>
    </div>`;
}

function roundDisplay(n) {
  // 表示用に小数点2桁まで
  return Math.round(n * 100) / 100;
}

function toggleShoppingDay(day) {
  const days = [...state.settings.shoppingDays];
  const idx  = days.indexOf(day);
  if (idx >= 0) {
    if (days.length <= 1) { showToast('⚠️ 最低1日は選択してください', 'error'); return; }
    days.splice(idx, 1);
  } else {
    days.push(day);
  }
  state.settings.shoppingDays = days;
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.classList.toggle('active', days.includes(parseInt(btn.dataset.day)));
  });
}

function updateNotifyDisplay() {
  const val = parseInt(document.getElementById('notify-slider').value);
  const h   = Math.floor(val / 4);
  const m   = (val % 4) * 15;
  document.getElementById('notify-display').textContent =
    `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function handleSettingsSave() {
  const s = state.settings;
  s.items.forEach(item => {
    const el  = document.getElementById(`daily-${item.id}`);
    if (!el) return;
    const val = parseFloat(el.value);
    if (val > 0) item.dailyAmount = val;
  });
  const sv     = parseInt(document.getElementById('notify-slider').value);
  s.notifyHour   = Math.floor(sv / 4);
  s.notifyMinute = (sv % 4) * 15;
  saveState();
  syncToServer();
  showToast('✅ 設定を保存しました');
  setTimeout(() => showScreen('home'), 900);
}

function handleSettingsReset() {
  if (!confirm('すべての設定をデフォルト値に戻しますか？\n（品目もリセットされます）')) return;
  state.settings  = deepCopy(DEFAULT_SETTINGS);
  state.inventory = buildDefaultInventory(DEFAULT_SETTINGS.items);
  saveState();
  renderSettings();
  showToast('✅ デフォルト値に戻しました');
}

function handleLogout() {
  if (!confirm('LINEアカウントからログアウトしますか？')) return;
  if (liffReady && typeof liff !== 'undefined') liff.logout();
  location.reload();
}

// ── 品目管理モーダル ──────────────────────────────────────
function showItemForm(itemId) {
  editingItemId = itemId;
  const modal = document.getElementById('modal-item-form');
  const title = document.getElementById('item-form-title');

  if (itemId) {
    const item = state.settings.items.find(i => i.id === itemId);
    if (!item) return;
    title.textContent = '品目を編集';
    document.getElementById('form-emoji').value               = item.emoji;
    document.getElementById('form-name').value                = item.name;
    document.getElementById('form-unit').value                = item.unit;
    document.getElementById('form-daily').value               = Math.round(item.dailyAmount * 10000) / 10000;
    document.getElementById('form-purchase-amount').value     = item.purchaseAmount;
    document.getElementById('form-purchase-unit-name').value  = item.purchaseUnitName || item.unit;
    document.getElementById('form-decimal').checked           = item.decimal;
  } else {
    title.textContent = '品目を追加';
    document.getElementById('form-emoji').value               = '';
    document.getElementById('form-name').value                = '';
    document.getElementById('form-unit').value                = '';
    document.getElementById('form-daily').value               = '1';
    document.getElementById('form-purchase-amount').value     = '1';
    document.getElementById('form-purchase-unit-name').value  = '';
    document.getElementById('form-decimal').checked           = false;
  }

  updateFormUnitLabels();
  modal.classList.remove('hidden');
}

function updateFormUnitLabels() {
  const unit = document.getElementById('form-unit').value || '単位';
  const el1  = document.getElementById('form-unit-label1');
  const el2  = document.getElementById('form-unit-label2');
  if (el1) el1.textContent = `${unit}/日`;
  if (el2) el2.textContent = unit;
}

function closeItemForm() {
  document.getElementById('modal-item-form').classList.add('hidden');
  editingItemId = null;
}

function saveItemForm() {
  const emoji     = document.getElementById('form-emoji').value.trim();
  const name      = document.getElementById('form-name').value.trim();
  const unit      = document.getElementById('form-unit').value.trim();
  const daily     = parseFloat(document.getElementById('form-daily').value);
  const purchAmt  = parseFloat(document.getElementById('form-purchase-amount').value);
  const purchName = document.getElementById('form-purchase-unit-name').value.trim() || unit;
  const decimal   = document.getElementById('form-decimal').checked;

  if (!name)              { showToast('⚠️ 品目名を入力してください', 'error'); return; }
  if (!unit)              { showToast('⚠️ 単位を入力してください', 'error'); return; }
  if (!daily || daily <= 0) { showToast('⚠️ 1日消費量を入力してください', 'error'); return; }
  if (!purchAmt || purchAmt <= 0) { showToast('⚠️ 購入量を入力してください', 'error'); return; }

  if (editingItemId) {
    const idx = state.settings.items.findIndex(i => i.id === editingItemId);
    if (idx >= 0) {
      state.settings.items[idx] = {
        ...state.settings.items[idx],
        emoji: emoji || '📦', name, unit,
        dailyAmount: daily, purchaseAmount: purchAmt,
        purchaseUnitName: purchName, decimal
      };
      if (state.inventory[editingItemId]) state.inventory[editingItemId].unit = unit;
    }
    showToast('✅ 品目を更新しました');
  } else {
    const newItem = {
      id: generateId(),
      emoji: emoji || '📦', name, unit,
      dailyAmount: daily, purchaseAmount: purchAmt,
      purchaseUnitName: purchName, decimal
    };
    state.settings.items.push(newItem);
    state.inventory[newItem.id] = { count: 0, unit, updatedAt: null };
    showToast('✅ 品目を追加しました');
  }

  saveState();
  syncToServer();
  closeItemForm();
  renderSettings();
}

function deleteItem(itemId) {
  const item = state.settings.items.find(i => i.id === itemId);
  if (!item) return;
  if (state.settings.items.length <= 1) {
    showToast('⚠️ 品目は最低1つ必要です', 'error');
    return;
  }
  if (!confirm(`「${item.name}」を削除しますか？\n在庫データも削除されます。`)) return;
  state.settings.items  = state.settings.items.filter(i => i.id !== itemId);
  delete state.inventory[itemId];
  saveState();
  syncToServer();
  renderSettings();
  showToast('🗑️ 品目を削除しました');
}

// ── サーバー同期 ──────────────────────────────────────────
function syncToServer() {
  const userId = lineProfile ? lineProfile.userId : 'anonymous';
  fetch('/api/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      userId,
      settings:     state.settings,
      inventory:    state.inventory,
      purchaseLogs: state.purchaseLogs
    })
  }).catch(() => {});
}

async function syncFromServer() {
  try {
    if (!lineProfile) return;
    const res = await fetch(`/api/data?userId=${encodeURIComponent(lineProfile.userId)}`);
    if (!res.ok) return;
    const serverData = await res.json();
    if (!serverData.inventory || !serverData.settings) return;

    const serverLatest = Object.values(serverData.inventory)
      .map(v => v.updatedAt ? new Date(v.updatedAt).getTime() : 0)
      .reduce((a, b) => Math.max(a, b), 0);
    const localLatest = Object.values(state.inventory)
      .map(v => v.updatedAt ? new Date(v.updatedAt).getTime() : 0)
      .reduce((a, b) => Math.max(a, b), 0);

    if (serverLatest > localLatest) {
      state.settings     = serverData.settings;
      state.inventory    = serverData.inventory;
      state.purchaseLogs = serverData.purchaseLogs || [];
      saveState();
      renderHome();
    }
  } catch (e) { /* ignore */ }
}

// ── ユーティリティ ────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDateTime(date) {
  const d  = new Date(date);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

// ── 初期化 ────────────────────────────────────────────────
async function init() {
  // ローディング表示
  document.getElementById('loading-screen').classList.remove('hidden');
  document.getElementById('app-wrapper').classList.add('hidden');
  document.querySelector('.bottom-nav').classList.add('hidden');

  loadState();

  const liffOk = await initLiff();
  if (!liffOk) return;  // LINEログインへリダイレクト中

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ローディング非表示
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('app-wrapper').classList.remove('hidden');
  document.querySelector('.bottom-nav').classList.remove('hidden');

  renderHome();
  syncFromServer();
}

init();
