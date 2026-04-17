// ═══════════════════════════════════════════════════════════
// PolyBot Dashboard — live polling + rendering
// ═══════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 3000;

// ─── Helpers ───
const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => {
  const val = Number(n) || 0;
  const sign = val >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(val).toFixed(2)}`;
};
const fmtPct = (n) => `${(Number(n) * 100).toFixed(1)}%`;

const fmtLocalTime = (iso) => {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso.slice(11, 19); }
};

async function api(path) {
  const res = await fetch(path, { credentials: 'include' });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('unauth'); }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ─── Me / Logout ───
async function loadMe() {
  try {
    const me = await api('/api/me');
    $('usernameTag').textContent = me.username.toUpperCase();
  } catch { window.location.href = '/login'; }
}
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  window.location.href = '/login';
});

// ─── Local Clock ───
setInterval(() => {
  $('localTime').textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // Refresh "last update" counter each second
  if (_lastStatusMs) {
    const age = Math.max(0, Math.floor((Date.now() - _lastStatusMs) / 1000));
    const el = $('lastUpdate');
    const tag = $('lastUpdateTag');
    if (!el) return;
    if (age < 10) { el.textContent = `${age}s`; tag.classList.remove('stale'); tag.classList.add('fresh'); }
    else if (age < 60) { el.textContent = `${age}s`; tag.classList.remove('fresh'); tag.classList.remove('stale'); }
    else if (age < 600) { el.textContent = `${Math.floor(age/60)}m ${age%60}s`; tag.classList.remove('fresh'); tag.classList.add('stale'); }
    else { el.textContent = `${Math.floor(age/60)}m`; tag.classList.remove('fresh'); tag.classList.add('stale'); }
  }
}, 1000);
let _lastStatusMs = null;

// ─── Summary Renderer ───
async function loadSummary() {
  const s = await api('/api/summary');

  // Wallet balance (from bot status, pushed each cycle)
  const walletBal = Number(s.status?.wallet_usdc || 0);
  const walletEl = $('walletBal');
  if (walletEl) {
    walletEl.textContent = walletBal > 0 ? `$${walletBal.toFixed(2)}` : '$--';
    walletEl.className = 'stat-big ' + (walletBal > 0 ? 'pos' : 'neutral');
  }

  // Unrealized P&L (on open positions, fetched from Polymarket live)
  const unrealized = Number(s.status?.unrealized_pnl || 0);
  const openValue = Number(s.status?.open_value_usd || 0);
  const unrealEl = $('unrealizedPnl');
  if (unrealEl) {
    unrealEl.textContent = fmtUsd(unrealized);
    unrealEl.className = 'stat-big ' + (unrealized > 0 ? 'pos' : unrealized < 0 ? 'neg' : 'neutral');
    $('unrealizedSub').textContent = openValue > 0 ? `open value $${openValue.toFixed(2)}` : 'no open positions';
  }

  // P&L (realized)
  const today = Number(s.pnl?.today || 0);
  const net = Number(s.pnl?.net || 0);
  const todayEl = $('todayPnl');
  todayEl.textContent = fmtUsd(today);
  todayEl.className = 'stat-big ' + (today > 0 ? 'pos' : today < 0 ? 'neg' : 'neutral');
  const netEl = $('netPnl');
  netEl.textContent = fmtUsd(net);
  netEl.className = 'stat-big ' + (net > 0 ? 'pos' : net < 0 ? 'neg' : 'neutral');
  $('todayPnlSub').textContent = `${s.trades?.total || 0} total trades`;
  $('netPnlSub').textContent = `${s.trades?.wins || 0}W / ${s.trades?.losses || 0}L`;

  // WR
  const wrOverall = Number(s.win_rate?.overall || 0.5);
  const wrRecent = Number(s.win_rate?.recent20 || 0.5);
  const wrEl = $('winRate');
  wrEl.textContent = fmtPct(wrOverall);
  wrEl.className = 'stat-big ' + (wrOverall >= 0.55 ? 'pos' : wrOverall >= 0.48 ? 'neutral' : 'neg');
  $('winRateSub').textContent = `last 20: ${fmtPct(wrRecent)}`;

  // Brier (compact, in Activity card)
  const brier = Number(s.brier || 0.25);
  const brierEl = $('brier');
  if (brierEl) {
    brierEl.textContent = brier.toFixed(3);
    brierEl.className = brier < 0.22 ? 'text-green' : brier < 0.27 ? 'text-amber' : 'text-red';
  }

  // Streak & open
  $('openTrades').textContent = s.trades?.open ?? 0;
  const ls = Number(s.consec_losses || 0);
  const lsEl = $('lossStreak');
  lsEl.textContent = ls;
  lsEl.className = ls >= 3 ? 'text-red' : ls >= 2 ? 'text-amber' : 'text-green';

  // Last-sync heartbeat: how old is the bot_status push?
  const syncIso = s.status?.updated_at;
  if (syncIso) {
    try { _lastStatusMs = new Date(syncIso).getTime(); } catch { _lastStatusMs = null; }
  }

  // Streak dots (last 10)
  const dotsWrap = $('streakDots');
  dotsWrap.innerHTML = '';
  (s.last_10 || []).slice().reverse().forEach(o => {
    const d = document.createElement('div');
    d.className = 'streak-dot ' + (o === 'WIN' ? 'win' : 'loss');
    dotsWrap.appendChild(d);
  });

  // Status
  const isLive = !!s.status?.running;
  $('statusDot').className = 'status-dot' + (isLive ? '' : ' offline');
  $('statusText').textContent = isLive ? 'LIVE' : 'OFFLINE';
  $('modeText').textContent = s.status?.dry_run ? 'DRY RUN' : 'LIVE TRADING';

  // Level + next cycle
  renderLevel(s.status || {});
  renderTimer(s.status || {});
}

// ─── Level ───
function renderLevel(status) {
  const lvl = status.scale_level;
  if (!lvl) {
    $('levelBadge').textContent = 'L--';
    $('levelBet').textContent = '--';
    $('levelProgress').style.width = '0%';
    $('levelNextUnlock').textContent = 'awaiting bot status...';
    return;
  }
  $('levelBadge').textContent = `L${lvl.id}`;
  $('levelBet').textContent = `$${Number(lvl.base_bet).toFixed(0)} / trade`;
  const nextUnlock = lvl.next_unlock;
  const currentPnl = Number(status.net_pnl || 0);
  if (nextUnlock && nextUnlock.min_pnl_required !== undefined) {
    const denom = nextUnlock.min_pnl_required - (lvl.min_pnl_required || 0);
    const numer = currentPnl - (lvl.min_pnl_required || 0);
    const pct = Math.max(0, Math.min(100, (numer / Math.max(denom, 1)) * 100));
    $('levelProgress').style.width = pct + '%';
    $('levelNextUnlock').textContent =
      `Next: L${nextUnlock.id} at +$${nextUnlock.min_pnl_required.toFixed(0)} (${pct.toFixed(0)}% there)`;
  } else {
    $('levelProgress').style.width = '100%';
    $('levelNextUnlock').textContent = 'Max level reached';
  }
}

// ─── Timer ───
let _cycleTimerInterval = null;
function renderTimer(status) {
  if (_cycleTimerInterval) clearInterval(_cycleTimerInterval);
  const nextCycleIso = status.next_cycle_at;
  if (!nextCycleIso) {
    $('cycleTimer').textContent = '--:--';
    $('cycleLabel').textContent = 'awaiting bot status...';
    return;
  }
  const targetMs = new Date(nextCycleIso).getTime();
  const tick = () => {
    const diff = Math.max(0, Math.floor((targetMs - Date.now()) / 1000));
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    $('cycleTimer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    $('cycleLabel').textContent = diff > 0 ? 'until next sweep' : 'sweep in progress...';
  };
  tick();
  _cycleTimerInterval = setInterval(tick, 1000);
}

// ─── Per-asset ───
async function loadAssets() {
  const data = await api('/api/per_asset');
  const container = $('assetList');
  if (!data.length) {
    container.innerHTML = '<div class="text-dim">no data yet</div>';
    return;
  }
  container.innerHTML = '';
  data.forEach(a => {
    const pct = Math.round(a.win_rate * 100);
    const cls = a.win_rate >= 0.55 ? 'good' : a.win_rate >= 0.45 ? 'mid' : 'bad';
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${a.asset}</div>
      <div class="bar-track">
        <div class="bar-fill ${cls}" style="width:${pct}%">${pct}%</div>
      </div>
      <div class="bar-val">${a.total}t ${fmtUsd(a.pnl)}</div>
    `;
    container.appendChild(row);
  });
}

// ─── WR by Timeframe ───
async function loadTimeframes() {
  const data = await api('/api/wr_by_timeframe');
  const container = $('timeframeList');
  if (!data.length) {
    container.innerHTML = '<div class="text-dim">no data yet</div>';
    return;
  }
  container.innerHTML = '';
  data.forEach(tf => {
    const pct = Math.round(tf.win_rate * 100);
    const cls = tf.win_rate >= 0.55 ? 'good' : tf.win_rate >= 0.45 ? 'mid' : 'bad';
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${tf.timeframe}</div>
      <div class="bar-track">
        <div class="bar-fill ${cls}" style="width:${pct}%">${pct}%</div>
      </div>
      <div class="bar-val">${tf.wins}/${tf.total}</div>
    `;
    container.appendChild(row);
  });
}

// ─── Hourly ───
async function loadHourly() {
  const data = await api('/api/hourly');
  const container = $('hourlyList');
  if (!data.length) {
    container.innerHTML = '<div class="text-dim">no data yet</div>';
    return;
  }
  const filtered = data.filter(h => h.total >= 3).sort((a, b) => b.win_rate - a.win_rate);
  if (!filtered.length) {
    container.innerHTML = '<div class="text-dim">need more samples</div>';
    return;
  }
  container.innerHTML = '';
  filtered.slice(0, 10).forEach(h => {
    const pct = Math.round(h.win_rate * 100);
    const cls = h.win_rate >= 0.60 ? 'good' : h.win_rate >= 0.45 ? 'mid' : 'bad';
    const localHour = _utcHourToLocal(h.hour);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${String(localHour).padStart(2, '0')}:00</div>
      <div class="bar-track">
        <div class="bar-fill ${cls}" style="width:${pct}%">${pct}%</div>
      </div>
      <div class="bar-val">${h.wins}/${h.total}</div>
    `;
    container.appendChild(row);
  });
}

function _utcHourToLocal(utcHour) {
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.getHours();
}

// ─── Top Signals ───
async function loadSignals() {
  const data = await api('/api/signals');
  const body = $('topSignals').querySelector('tbody');
  if (!data.top.length) {
    body.innerHTML = '<tr><td colspan="4" class="text-dim">learning...</td></tr>';
    return;
  }
  body.innerHTML = '';
  data.top.forEach(s => {
    const tr = document.createElement('tr');
    const wr = Number(s.win_rate);
    const cls = wr >= 0.60 ? 'text-green' : wr >= 0.50 ? 'text-amber' : 'text-red';
    tr.innerHTML = `
      <td>${s.signal_name}</td>
      <td class="td-num ${cls}">${fmtPct(wr)}</td>
      <td class="td-num text-dim">${s.times_correct}/${s.times_seen}</td>
      <td class="td-num text-green">${Number(s.weight).toFixed(2)}x</td>
    `;
    body.appendChild(tr);
  });
}

// ─── Recent Trades ───
async function loadTrades() {
  const data = await api('/api/trades?limit=25');
  const body = $('tradesTable').querySelector('tbody');
  if (!data.length) {
    body.innerHTML = '<tr><td colspan="10" class="text-dim">no trades yet</td></tr>';
    return;
  }
  body.innerHTML = '';
  data.forEach(t => {
    const outcome = t.outcome || 'PENDING';
    const ocls = outcome === 'WIN' ? 'outcome-win'
      : outcome === 'LOSS' ? 'outcome-loss' : 'outcome-pending';
    const dir = t.direction || '--';
    const dcls = dir === 'UP' ? 'badge-up' : 'badge-down';
    const pnl = Number(t.pnl || 0);
    const pnlCls = pnl > 0 ? 'outcome-win' : pnl < 0 ? 'outcome-loss' : 'text-dim';
    const tf = t.timeframe || '5m';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-dim">${fmtLocalTime(t.timestamp)}</td>
      <td>${t.asset || '--'}</td>
      <td class="text-dim">${tf}</td>
      <td class="${dcls}">${dir}</td>
      <td class="td-num">$${Number(t.entry_price || 0).toFixed(3)}</td>
      <td class="td-num">$${Number(t.size_usd || 0).toFixed(2)}</td>
      <td class="td-num text-dim">${Math.round((t.confidence || 0) * 100)}%</td>
      <td class="text-dim">${t.status || '--'}</td>
      <td class="${ocls}">${outcome}</td>
      <td class="td-num ${pnlCls}">${fmtUsd(pnl)}</td>
    `;
    body.appendChild(tr);
  });
}

// ─── Cumulative P&L sparkline ───
async function loadPnlChart() {
  const data = await api('/api/pnl_series?limit=200');
  const svg = $('pnlSpark');
  svg.innerHTML = '';
  if (!data.length) return;

  const W = 600, H = 120, PAD = 6;
  const values = data.map(d => d.cum_pnl);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = (max - min) || 1;

  const x = (i) => PAD + (i / Math.max(1, values.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - min) / range) * (H - PAD * 2);

  // Zero line
  const zeroY = y(0);
  svg.insertAdjacentHTML('beforeend',
    `<line x1="${PAD}" x2="${W - PAD}" y1="${zeroY}" y2="${zeroY}"
           stroke="rgba(78,148,108,0.12)" stroke-dasharray="3 4" />`);

  // Path
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];
  const color = last >= 0 ? '#5cb87a' : '#c44455';
  const colorDim = last >= 0 ? '#3b7a54' : '#8a3040';

  svg.insertAdjacentHTML('beforeend', `
    <defs>
      <linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${colorDim}" stop-opacity="0.25" />
        <stop offset="100%" stop-color="${colorDim}" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path d="${path} L ${x(values.length - 1)} ${zeroY} L ${x(0)} ${zeroY} Z"
          fill="url(#areaGrad)" />
    <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5"
          stroke-linejoin="round" />
    <circle cx="${x(values.length - 1)}" cy="${y(last)}" r="2.5" fill="${color}" />
  `);
}

// ─── Refresh loop ───
async function refreshAll() {
  try {
    await Promise.all([
      loadSummary(),
      loadAssets(),
      loadTimeframes(),
      loadHourly(),
      loadSignals(),
      loadTrades(),
      loadPnlChart(),
    ]);
  } catch (e) {
    if (e.message !== 'unauth') console.warn('refresh err', e);
  }
}

// ─── Collapsible sections ───
$('tradesToggle').addEventListener('click', () => {
  const body = $('tradesBody');
  const chevron = $('tradesChevron');
  body.classList.toggle('collapsed');
  chevron.classList.toggle('collapsed');
});

loadMe().then(() => {
  refreshAll();
  setInterval(refreshAll, POLL_INTERVAL_MS);
});
