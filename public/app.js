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

// ─── Local Clock + UTC tooltip (P3.4 — Austin operator) ───────
setInterval(() => {
  const now = new Date();
  const local = now.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const utc = now.toISOString().slice(11, 19) + 'Z';
  const clk = $('localTime');
  if (clk) {
    clk.textContent = `${local} · ${utc}`;
    clk.title = 'local · UTC';
  }
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
  window.__lastSummary = s;

  // Wallet balance — on-chain ground-truth, from the same RPC+USDC.e
  // contract the trading bot reads. Falls back to heartbeat-reported value
  // only if RPC query failed. Never fall back to a stale sticky value, since
  // the whole point of this card is that it reflects what's actually on-chain.
  const onchain = (s.wallet?.onchain_usdc != null) ? Number(s.wallet.onchain_usdc) : null;
  const heartbeatBal = Number(s.wallet?.heartbeat_usdc || 0);
  const walletBal = onchain != null ? onchain : (heartbeatBal > 0 ? heartbeatBal : null);
  const realizedToday = Number(s.pnl?.today || 0);
  const walletEl = $('walletBal');
  if (walletEl) {
    if (walletBal != null) {
      walletEl.textContent = `$${walletBal.toFixed(2)}`;
      walletEl.className = 'stat-big ' + (realizedToday >= 0 ? 'pos' : 'neutral');
    } else {
      walletEl.textContent = '$--';
      walletEl.className = 'stat-big text-dim';
    }
  }
  const walletSub = $('walletSub');
  if (walletSub) {
    const src = onchain != null ? 'on-chain' : (heartbeatBal > 0 ? 'heartbeat (RPC unreachable)' : '--');
    const pnlTag = realizedToday === 0 ? '' : ` · ${fmtUsd(realizedToday)} today`;
    walletSub.textContent = `USDC.e ${src}${pnlTag}`;
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
  // Today's P&L sub-label shows trade count for today, not lifetime — keeps
  // the wallet-sub "today" tag and this card in sync (P1.3 regression fix).
  const nToday = (Number(s.wins_today || 0) + Number(s.losses_today || 0));
  $('todayPnlSub').textContent = `${nToday} resolved today · ${s.wins_today || 0}W/${s.losses_today || 0}L`;
  $('netPnlSub').textContent = `${s.trades?.wins || 0}W / ${s.trades?.losses || 0}L lifetime`;

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

  // Streak & open. `consec_losses` is "current streak from the most-recent
  // resolved trade". When the latest trade is a WIN the streak is 0 — which
  // is correct but reads as wrong, hence the explicit "current" label plus a
  // separate "max today" metric (P1.4).
  $('openTrades').textContent = s.trades?.open ?? 0;
  const ls = Number(s.consec_losses || 0);
  const lsEl = $('lossStreak');
  lsEl.textContent = ls;
  lsEl.className = ls >= 3 ? 'text-red' : ls >= 2 ? 'text-amber' : 'text-green';
  const mst = Number(s.max_loss_streak_today || 0);
  const mstEl = $('maxStreakToday');
  if (mstEl) {
    mstEl.textContent = mst;
    mstEl.className = mst >= 5 ? 'text-red' : mst >= 3 ? 'text-amber' : 'text-dim';
  }

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

  // Bot state: OFFLINE | STALE | HALTED | LIVE | PAUSED. Derived from
  // (a) self-reported running flag, (b) heartbeat freshness from the server
  // (age vs STALE_AFTER_SEC), (c) any active kill-switch halts.
  const running = !!s.status?.running;
  const ageSec = (s.heartbeat?.age_sec != null) ? Number(s.heartbeat.age_sec) : null;
  const fresh = !!s.heartbeat?.is_fresh;
  const halts = Array.isArray(s.status?.killswitches) ? s.status.killswitches : [];
  const globalHalt = halts.some(h => [1,3,4,5].includes(Number(h.rail_id)));
  const shadow = !!s.status?.shadow_mode;
  let state = 'UNKNOWN';
  if (!running) state = 'OFFLINE';
  else if (!fresh) state = 'STALE';
  else if (globalHalt) state = 'HALTED';
  else state = shadow ? 'SHADOW' : 'LIVE';

  $('statusDot').className = 'status-dot' + (state === 'LIVE' || state === 'SHADOW' ? '' : ' offline');
  $('statusText').textContent = state;
  $('modeText').textContent = shadow ? 'SHADOW MODE' : 'LIVE TRADING';

  renderStateBanner(state, ageSec, halts, s);

  // Control state — prefer the dashboard-side truth (bot_control table) over
  // the bot's self-reported echo, since the bot may take a cycle to catch up.
  let ctrl = (s.control_state || '').toLowerCase();
  if (!ctrl) ctrl = (s.status?.control_state || '').toLowerCase();
  if (ctrl === 'paused' || ctrl === 'pause') applyControlState('pause');
  else applyControlState('start');

  // Level + next cycle
  renderLevel(s.status || {});
  renderTimer(s.status || {});

  // Live Polymarket positions (pushed on bot heartbeat)
  renderPositions(s.status || {});

  // Safety panels fed from heartbeat payload
  renderRails(halts, s.status || {}, fresh, running);
  renderDailyCap(s);
  renderCalibration(s.status || {});
  renderTierLadder(s.status || {});
  renderScanCount(s.status || {});
  renderWsStatus(s.status || {}, fresh, running);
}

// ─── Stale / Offline / Halt Banner ──────────────────────────────
function renderStateBanner(state, ageSec, halts, s) {
  const el = $('stateBanner');
  if (!el) return;
  const ageTxt = ageSec == null ? '--' : (ageSec >= 60 ? `${Math.floor(ageSec/60)}m ${ageSec%60}s` : `${ageSec}s`);
  const iso = s.heartbeat?.updated_at;
  const lastLocal = iso ? new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '--';

  if (state === 'OFFLINE') {
    el.className = 'state-banner off';
    el.innerHTML = `<strong>BOT OFFLINE</strong> — last heartbeat ${ageTxt} ago (${lastLocal} local). No scans, no orders.`;
    el.style.display = 'block';
  } else if (state === 'STALE') {
    el.className = 'state-banner stale';
    el.innerHTML = `<strong>DATA STALE</strong> — last sync ${ageTxt} ago. Bot may have crashed, check the machine.`;
    el.style.display = 'block';
  } else if (state === 'HALTED') {
    const fired = halts.filter(h => [1,3,4,5].includes(Number(h.rail_id)))
      .map(h => `#${h.rail_id} ${h.rail_name || ''}`).join(' · ');
    el.className = 'state-banner halt';
    el.innerHTML = `<strong>KILL-SWITCH HALT</strong> — ${fired}. Live trading blocked until cooldown/reset.`;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

// ─── Kill-Switch Rails Panel ────────────────────────────────────
const RAIL_META = [
  { id: 1, name: 'Consecutive red days',    short: 'RAIL 1' },
  { id: 2, name: 'Cell WR drift',            short: 'RAIL 2' },
  { id: 3, name: 'Intraday drawdown 40%',    short: 'RAIL 3' },
  { id: 4, name: 'Slippage doubling',        short: 'RAIL 4' },
  { id: 5, name: 'Daily loss cap',           short: 'RAIL 5' },
];
function renderRails(halts, status, fresh, running) {
  const wrap = $('railsGrid');
  if (!wrap) return;
  const byId = new Map(halts.map(h => [Number(h.rail_id), h]));
  // One-shot rail-fire event (most recent) comes through status.killswitch_event.
  // Active halts stream through status.killswitches. Both feed the display.
  const lastEvt = status.killswitch_event || null;
  wrap.innerHTML = '';
  RAIL_META.forEach(r => {
    const halt = byId.get(r.id);
    let cls = 'rail-armed', label = 'ARMED', detail = '—';
    if (halt) {
      const cooling = halt.action === 'cooldown' || halt.action === 'cooling';
      cls = cooling ? 'rail-cooling' : 'rail-fired';
      label = cooling ? 'COOLING' : 'FIRED';
      const iso = halt.fired_at_utc || halt.fired_at || '';
      const at = iso ? new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '--';
      const det = halt.details ? JSON.stringify(halt.details).slice(0, 80) : '';
      detail = `${at} · ${det || halt.action || ''}`;
    } else if (lastEvt && Number(lastEvt.rail_id) === r.id) {
      const iso = lastEvt.fired_at_utc || '';
      const at = iso ? new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '--';
      detail = `last fired ${at}`;
    } else if (!running || !fresh) {
      detail = 'heartbeat stale';
    }
    const div = document.createElement('div');
    div.className = `rail-cell ${cls}`;
    div.innerHTML = `
      <div class="rail-head">
        <span class="rail-num">${r.short}</span>
        <span class="rail-state">${label}</span>
      </div>
      <div class="rail-name">${r.name}</div>
      <div class="rail-detail">${detail}</div>
    `;
    wrap.appendChild(div);
  });
}

// ─── Daily Loss Cap Thermometer (Rail 5) ────────────────────────
function renderDailyCap(s) {
  const fill = $('dailyCapFill');
  const used = $('dailyCapUsed');
  const total = $('dailyCapTotal');
  const note = $('dailyCapNote');
  if (!fill) return;
  const today = Number(s.pnl?.today || 0);
  const loss = today < 0 ? -today : 0;
  // Cap = max($50 × ticket_mult, 0.05 × wallet). Walletis on-chain.
  const wallet = Number(s.wallet?.onchain_usdc || s.wallet?.heartbeat_usdc || 0);
  const pilot = Number(s.status?.rail5_pilot_ticket_usd || 5);
  const avgTicket = Number(s.status?.avg_ticket_today_usd || pilot);
  const mult = Math.max(1.0, avgTicket / Math.max(pilot, 1e-6));
  const absCap = Math.max(50 * mult, 0.05 * wallet);
  const pct = Math.min(100, (loss / Math.max(absCap, 1)) * 100);
  fill.style.width = `${pct.toFixed(1)}%`;
  fill.className = 'thermo-fill ' + (pct >= 90 ? 'hot' : pct >= 60 ? 'warm' : 'cool');
  used.textContent = loss > 0 ? `loss $${loss.toFixed(2)}` : `P&L ${fmtUsd(today)}`;
  total.textContent = `cap $${absCap.toFixed(0)}`;
  note.textContent = `rail 5 · mult ${mult.toFixed(2)}× · 5% of $${wallet.toFixed(0)} wallet`;
}

// ─── Current Calibration Display ────────────────────────────────
function renderCalibration(status) {
  const el = $('calibBlock');
  if (!el) return;
  const calib = status.calibration || {};
  const sigma = calib.per_asset_sigma_mult || status.per_asset_sigma_mult || {};
  const alpha = calib.market_blend_weight ?? status.market_blend_weight;
  const minFairOnSide = calib.min_fair_prob_on_side ?? status.min_fair_prob_on_side;
  const activeGates = calib.active_gates || status.active_gates || [];
  if (!Object.keys(sigma).length && alpha == null && !activeGates.length) {
    el.innerHTML = '<div class="text-dim">awaiting heartbeat…</div>';
    return;
  }
  const sigmaRows = Object.keys(sigma).sort().map(k => `
    <tr><td class="text-dim">${k}</td><td class="td-num">${Number(sigma[k]).toFixed(2)}×</td></tr>`).join('');
  const gatesList = (activeGates.length ? activeGates : ['(none reported)'])
    .map(g => `<span class="gate-chip">${g}</span>`).join(' ');
  el.innerHTML = `
    <div class="flex" style="gap:18px; flex-wrap:wrap;">
      <div style="flex:1; min-width:160px;">
        <div class="card-section-label">σ per asset</div>
        <table class="mini-table">${sigmaRows || '<tr><td class="text-dim" colspan="2">--</td></tr>'}</table>
      </div>
      <div style="flex:1; min-width:160px;">
        <div class="card-section-label">α (blend)</div>
        <div class="stat-big pos" style="font-size:1.6rem;">${alpha != null ? Number(alpha).toFixed(2) : '--'}</div>
        <div class="stat-sub">market-blend weight</div>
        <div class="card-section-label" style="margin-top:10px;">min fair-on-side</div>
        <div class="text-green">${minFairOnSide != null ? Number(minFairOnSide).toFixed(2) : '--'}</div>
      </div>
    </div>
    <div class="card-section" style="margin-top:10px;">
      <div class="card-section-label">active gates</div>
      <div>${gatesList}</div>
    </div>
  `;
}

// ─── Tier Ladder per-cell ───────────────────────────────────────
function renderTierLadder(status) {
  const el = $('tierBlock');
  if (!el) return;
  const tiers = Array.isArray(status.tier_ladder) ? status.tier_ladder : [];
  if (!tiers.length) {
    el.innerHTML = '<div class="text-dim">no live cells yet (tier ladder empty until first live fill)</div>';
    return;
  }
  const rows = tiers.map(c => {
    const shadowDelta = (c.live_wr != null && c.shadow_wr != null)
      ? ((Number(c.live_wr) - Number(c.shadow_wr)) * 100).toFixed(1) + 'pp'
      : '--';
    const pct = Math.min(100, ((c.live_n || 0) / Math.max(c.n_required || 1, 1)) * 100);
    const cls = shadowDelta.startsWith('-') ? 'text-red' : 'text-green';
    return `
      <tr>
        <td>${c.asset || '?'}/${c.timeframe || '?'}</td>
        <td class="td-num">T${c.tier || 0}</td>
        <td class="td-num">$${Number(c.ticket_usd || 0).toFixed(0)}</td>
        <td>
          <div class="tier-bar"><div class="tier-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="stat-sub">${c.live_n || 0} / ${c.n_required || '--'}</div>
        </td>
        <td class="td-num ${cls}">${shadowDelta}</td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <table class="mini-table">
      <thead><tr><th>cell</th><th class="td-num">tier</th><th class="td-num">ticket</th><th>progress</th><th class="td-num">Δ vs shadow</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─── Scan count ticker ──────────────────────────────────────────
function renderScanCount(status) {
  const el = $('scanCount');
  if (!el) return;
  const n = status.scan_count ?? status.cycle_number ?? null;
  el.textContent = n != null ? String(n) : '--';
}

// ─── Chainlink WS Status Light ──────────────────────────────────
function renderWsStatus(status, fresh, running) {
  const dot = $('wsDot');
  const txt = $('wsText');
  if (!dot || !txt) return;
  // Heartbeat surfaces `chainlink_ws.connected`/`.reconnecting` (structured)
  // or top-level `chainlink_connected` bool fallback. Without it, infer
  // from heartbeat freshness — if the bot is pushing, something is talking
  // to Chainlink (or the bot would have WARN'd its way into stale-strike
  // fallbacks already).
  const cl = status.chainlink_ws || {};
  const connected = cl.connected ?? status.chainlink_connected;
  const reconnecting = cl.reconnecting ?? status.chainlink_reconnecting;
  if (!running || !fresh) {
    dot.className = 'ws-dot off'; txt.textContent = 'unknown';
  } else if (reconnecting) {
    dot.className = 'ws-dot warn'; txt.textContent = 'reconnecting…';
  } else if (connected === false) {
    dot.className = 'ws-dot off'; txt.textContent = 'disconnected';
  } else {
    dot.className = 'ws-dot ok'; txt.textContent = 'connected';
  }
}

// ─── Live Polymarket Positions (from bot heartbeat) ───
function renderPositions(status) {
  const positions = Array.isArray(status.positions) ? status.positions : [];
  const body = $('positionsTable')?.querySelector('tbody');
  if (!body || !$('posCount')) return;

  if (!positions.length) {
    body.innerHTML = '<tr><td colspan="7" class="text-dim">no positions</td></tr>';
    $('posCount').textContent = '0';
    $('posStatusBreakdown').textContent = 'no positions';
    $('posCost').textContent = '$--';
    $('posCurVal').textContent = '$--';
    $('posUnreal').textContent = '$--';
    $('posUnreal').className = 'stat-big';
    return;
  }

  let totalCost = 0, totalCur = 0;
  const statusCounts = { LIVE: 0, WIN: 0, LOSS: 0, SETTLED: 0 };

  body.innerHTML = '';
  positions.forEach(p => {
    const shares = Number(p.size || 0);
    const avg = Number(p.avgPrice || 0);
    const cv = Number(p.currentValue || 0);
    const pnl = Number(p.pnl || 0);
    const cost = shares * avg;
    totalCost += cost;
    totalCur += cv;

    const stat = p.status || 'LIVE';
    statusCounts[stat] = (statusCounts[stat] || 0) + 1;

    const statCls = stat === 'WIN' ? 'outcome-win'
      : stat === 'LOSS' ? 'outcome-loss'
      : stat === 'LIVE' ? 'text-amber'
      : 'text-dim';
    const pnlCls = pnl > 0 ? 'outcome-win' : pnl < 0 ? 'outcome-loss' : 'text-dim';
    const dir = String(p.outcome || '').toUpperCase();
    const dcls = dir === 'UP' ? 'badge-up' : 'badge-down';
    const rawTitle = p.title || p.slug || '--';
    const shortTitle = rawTitle.replace(
      /^(Bitcoin|Ethereum|Solana|Dogecoin|XRP|Avalanche|Chainlink)\s+Up or Down\s+/i, ''
    ).slice(0, 52);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${shortTitle}</td>
      <td class="${dcls}">${dir || '--'}</td>
      <td class="td-num">${shares.toFixed(2)}</td>
      <td class="td-num">$${avg.toFixed(3)}</td>
      <td class="td-num">$${cv.toFixed(2)}</td>
      <td class="td-num ${pnlCls}">${fmtUsd(pnl)}</td>
      <td class="${statCls}">${stat}</td>
    `;
    body.appendChild(tr);
  });

  const totalPnl = totalCur - totalCost;
  $('posCount').textContent = String(positions.length);
  $('posStatusBreakdown').textContent =
    `${statusCounts.LIVE} live · ${statusCounts.WIN} win · ${statusCounts.LOSS} loss`;
  $('posCost').textContent = `$${totalCost.toFixed(2)}`;
  $('posCurVal').textContent = `$${totalCur.toFixed(2)}`;
  const unrealEl = $('posUnreal');
  unrealEl.textContent = fmtUsd(totalPnl);
  unrealEl.className = 'stat-big ' + (totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : 'neutral');
}

// ─── Level ───
function renderLevel(status) {
  const lvl = status.scale_level;
  const running = !!status.running;
  if (!lvl) {
    // Tie empty-state text to whether the bot is running. A silent "L--"
    // with the bot off looks identical to a running bot that hasn't sent
    // level data yet — differentiate so the operator can tell which.
    $('levelBadge').textContent = 'L--';
    $('levelBet').textContent = running ? 'awaiting…' : 'bot off';
    $('levelProgress').style.width = '0%';
    $('levelNextUnlock').textContent = running
      ? 'awaiting bot status…'
      : 'bot offline — no scale level';
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
  const running = !!status.running;
  if (!nextCycleIso) {
    $('cycleTimer').textContent = '--:--';
    $('cycleLabel').textContent = running ? 'awaiting bot status…' : 'bot offline';
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

// ─── Per-asset — LIVE vs SHADOW distinction ──────────────────────
// LIVE_ASSETS surfaces from the bot heartbeat (status.live_assets). Any
// asset not in that set is shadow-only. Default to BTC until the bot
// confirms — matches CLAUDE.md policy for today's launch.
function liveAssets() {
  const s = window.__lastSummary || {};
  const la = s.status?.live_assets;
  if (Array.isArray(la) && la.length) return new Set(la.map(a => String(a).toUpperCase()));
  return new Set(['BTC']);
}
async function loadAssets() {
  const data = await api('/api/per_asset');
  const container = $('assetList');
  if (!data.length) {
    container.innerHTML = '<div class="text-dim">no data yet</div>';
    return;
  }
  const liveSet = liveAssets();
  container.innerHTML = '';
  data.forEach(a => {
    const pct = Math.round(a.win_rate * 100);
    const cls = a.win_rate >= 0.55 ? 'good' : a.win_rate >= 0.45 ? 'mid' : 'bad';
    const assetUpper = String(a.asset || '').toUpperCase();
    const isLive = liveSet.has(assetUpper);
    const badgeHtml = `<span class="mode-badge ${isLive ? 'badge-live' : 'badge-shadow'}">${isLive ? 'LIVE' : 'SHADOW'}</span>`;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${assetUpper} ${badgeHtml}</div>
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

// ─── Polybot Avatar (reactive to trade outcomes) ───
const bot = {
  stage: null, avatar: null, speech: null, arrows: null, notebook: null,
  mood: null, winCount: 0, lossCount: 0,
  lastResolvedId: null, firstLoad: true,
  speechTimer: null, stateTimer: null, nbTimer: null, ambientTimer: null,
  recentTrades: [],
};

function initBot() {
  bot.stage    = $('botStage');
  bot.avatar   = $('botAvatar');
  bot.speech   = $('botSpeech');
  bot.arrows   = $('botArrows');
  bot.notebook = $('botNotebook');
  bot.mood     = $('botMood');
  if (!bot.stage) return;
  bot.stage.addEventListener('click', () => botAngry());
}

function botSetMood(label, cls) {
  if (!bot.mood) return;
  bot.mood.textContent = label;
  bot.mood.className = cls || 'text-green';
}

function botSay(text, variant) {
  if (!bot.speech) return;
  bot.speech.className = 'bot-speech show' + (variant ? ' ' + variant : '');
  bot.speech.textContent = text;
  if (bot.speechTimer) clearTimeout(bot.speechTimer);
  bot.speechTimer = setTimeout(() => {
    bot.speech.className = 'bot-speech';
  }, 2600);
}

function botClearState(delay) {
  if (bot.stateTimer) clearTimeout(bot.stateTimer);
  bot.stateTimer = setTimeout(() => {
    if (bot.avatar) bot.avatar.classList.remove('happy', 'sad', 'angry');
    botSetMood('patrolling', 'text-green');
  }, delay || 1600);
}

function botWin() {
  if (!bot.avatar) return;
  bot.avatar.classList.remove('sad', 'angry');
  bot.avatar.classList.add('happy');
  botSetMood('celebrating', 'text-green');
  botSay('CASHED IN!', '');
  fireArrows(6);
  bot.winCount++;
  const el = $('botWinCount'); if (el) el.textContent = bot.winCount;
  botClearState(1800);
}

function botLoss() {
  if (!bot.avatar) return;
  bot.avatar.classList.remove('happy', 'angry');
  bot.avatar.classList.add('sad');
  botSetMood('taking notes', 'text-amber');
  botSay('NOTED.', 'warn');
  showNotebook();
  bot.lossCount++;
  const el = $('botLossCount'); if (el) el.textContent = bot.lossCount;
  botClearState(2200);
}

function botAngry() {
  if (!bot.avatar) return;
  bot.avatar.classList.remove('happy', 'sad');
  bot.avatar.classList.add('angry');
  const lines = ['HEY!', 'STOP POKING!', 'RUDE.', 'I AM WORKING.', 'LEAVE ME ALONE!'];
  botSay(lines[Math.floor(Math.random() * lines.length)], 'bad');
  botSetMood('annoyed', 'text-red');
  botClearState(1400);
}

function fireArrows(n) {
  if (!bot.arrows) return;
  bot.arrows.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const a = document.createElement('div');
    a.className = 'bot-arrow';
    const angle = -20 - Math.random() * 50;  // upward-ish
    const dist  = 160 + Math.random() * 120;
    const dx = Math.cos(angle * Math.PI / 180) * dist;
    const dy = Math.sin(angle * Math.PI / 180) * dist;
    a.style.setProperty('--ang', angle + 'deg');
    a.style.setProperty('--dx',  dx.toFixed(0) + 'px');
    a.style.setProperty('--dy',  dy.toFixed(0) + 'px');
    a.style.animationDelay = (i * 0.07).toFixed(2) + 's';
    bot.arrows.appendChild(a);
  }
  setTimeout(() => { if (bot.arrows) bot.arrows.innerHTML = ''; }, 1800);
}

function showNotebook() {
  if (!bot.notebook) return;
  bot.notebook.classList.add('show');
  if (bot.nbTimer) clearTimeout(bot.nbTimer);
  bot.nbTimer = setTimeout(() => {
    if (bot.notebook) bot.notebook.classList.remove('show');
  }, 2400);
}

// Called by loadTrades — triggers reactions on NEW resolved trades only.
// Also records rolling sample for ambient chatter.
function botReactToTrades(trades) {
  bot.recentTrades = trades.slice(0, 20);
  const latest = trades.find(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  if (!latest) return;
  const id = latest.trade_id;
  if (bot.firstLoad) {
    bot.lastResolvedId = id;
    bot.firstLoad = false;
    return;
  }
  if (id === bot.lastResolvedId) return;
  bot.lastResolvedId = id;
  if (latest.outcome === 'WIN') botWin();
  else if (latest.outcome === 'LOSS') botLoss();
}

// ─── Ambient chatter (every ~10s) ───────────────────────────────
const PHRASES = {
  neutral: [
    "Coffee first. Trades second.",
    "Just vibing with the orderbook.",
    "ETH is doing ETH things.",
    "BTC, make up your mind.",
    "Scanning 5m candles…",
    "Waiting for that juicy edge.",
    "Probing liquidity, boss.",
    "Books look thin. Patient.",
    "Nothing spicy yet.",
    "Markets chill. I'm chill.",
    "Eyes peeled. Fingers ready.",
    "Running diagnostics. All green.",
  ],
  hot: [
    "Damn, we're RAMPING up!",
    "This streak is unreal.",
    "Edge is printing money.",
    "Big chad energy today.",
    "Books are GIVING.",
    "We're cooking, boss.",
    "Catch me if you can.",
    "Feels illegal to be this good.",
  ],
  cold: [
    "Today's a slow one…",
    "Market's being rude.",
    "No edge, no trade.",
    "Bored. Send signals.",
    "Liquidity is shy today.",
    "Patience mode: activated.",
    "We'll get 'em next cycle.",
  ],
  paper: [
    "Still on paper. Learning.",
    "Building the brain…",
    "n < 500. Grinding.",
    "Gate's watching me.",
    "Paper mode, big dreams.",
    "Almost there. Keep the faith.",
  ],
};

function pickPhraseBucket() {
  const trades = bot.recentTrades || [];
  const resolved = trades.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  if (resolved.length < 3) {
    const mode = (window.__lastMode || 'paper').toLowerCase();
    return mode === 'paper' ? 'paper' : 'neutral';
  }
  const recent = resolved.slice(0, 10);
  const wins = recent.filter(t => t.outcome === 'WIN').length;
  const rate = wins / recent.length;
  const pnl  = recent.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  if (rate >= 0.7 || pnl >= 25) return 'hot';
  if (rate <= 0.35 || pnl <= -10) return 'cold';
  return 'neutral';
}

function botAmbient() {
  if (!bot.speech) return;
  // Don't step on an event-driven line that's currently shown.
  if (bot.speech.classList.contains('show')) return;
  const bucket = pickPhraseBucket();
  const pool = PHRASES[bucket] || PHRASES.neutral;
  const phrase = pool[Math.floor(Math.random() * pool.length)];
  bot.speech.className = 'bot-speech show';
  bot.speech.textContent = phrase;
  if (bot.ambientTimer) clearTimeout(bot.ambientTimer);
  bot.ambientTimer = setTimeout(() => {
    if (bot.speech) bot.speech.className = 'bot-speech';
  }, 4500);
}

// ─── Control buttons (Start / Pause) ───
async function sendControl(cmd) {
  const el = $('ctrlStatus');
  if (el) { el.className = 'ctrl-status'; el.textContent = 'sending…'; }
  try {
    const r = await fetch('/api/bot/control', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    if (!r.ok) {
      let msg = 'FAILED';
      try { const j = await r.json(); msg = (j.detail || '').slice(0, 60) || msg; } catch {}
      throw new Error(msg);
    }
    const j = await r.json();
    applyControlState(j.command || cmd);
    botSay(cmd === 'pause' ? 'taking a break.' : "let's go!", cmd === 'pause' ? 'warn' : '');
  } catch (e) {
    if (el) { el.className = 'ctrl-status err'; el.textContent = String(e.message || 'FAILED'); }
  }
}
function applyControlState(cmd) {
  const sb = $('startBtn');
  const pb = $('pauseBtn');
  const el = $('ctrlStatus');
  if (!sb || !pb) return;
  const paused = (cmd === 'pause');
  sb.classList.toggle('active', !paused);
  pb.classList.toggle('active', paused);
  if (el) {
    el.className = 'ctrl-status ' + (paused ? 'warn' : 'ok');
    el.textContent = paused ? 'PAUSED' : 'RUNNING';
  }
}
function bindControls() {
  const sb = $('startBtn');
  const pb = $('pauseBtn');
  if (sb) sb.addEventListener('click', () => sendControl('start'));
  if (pb) pb.addEventListener('click', () => sendControl('pause'));
  bindEstop();
}

// ─── Emergency Stop ────────────────────────────────────────────
// Hard pause via the same /api/bot/control endpoint — the bot reads the
// pause flag on its next tick and declines new entries. Typed-confirm
// modal forces a deliberate 3am action, not a thumb-slip on mobile.
function bindEstop() {
  const openBtn = $('estopOpenBtn');
  const modal = $('estopModal');
  const confirmInp = $('estopConfirm');
  const goBtn = $('estopGo');
  const cancelBtn = $('estopCancel');
  const errEl = $('estopErr');
  if (!openBtn || !modal) return;

  const close = () => {
    modal.style.display = 'none';
    if (confirmInp) confirmInp.value = '';
    if (goBtn) goBtn.disabled = true;
    if (errEl) errEl.textContent = '';
  };
  const open = () => {
    modal.style.display = 'flex';
    setTimeout(() => confirmInp && confirmInp.focus(), 50);
  };

  openBtn.addEventListener('click', open);
  cancelBtn && cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  confirmInp && confirmInp.addEventListener('input', () => {
    goBtn.disabled = confirmInp.value.trim().toUpperCase() !== 'STOP';
  });
  goBtn && goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    errEl.textContent = '';
    try {
      const r = await fetch('/api/bot/control', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'pause' }),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const j = await r.json(); if (j.detail) msg = j.detail; } catch {}
        throw new Error(msg);
      }
      applyControlState('pause');
      close();
      botSay('STOPPED.', 'bad');
    } catch (e) {
      errEl.textContent = `failed: ${e.message || e}`;
      goBtn.disabled = false;
    }
  });
}

// ─── Top Signals (legacy, kept for back-compat if #topSignals ever re-added) ───
async function loadSignals() {
  const tbl = $('topSignals');
  if (!tbl) return;
  const data = await api('/api/signals');
  const body = tbl.querySelector('tbody');
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
  botReactToTrades(data);
  data.forEach(t => {
    const outcome = t.outcome || 'PENDING';
    const ocls = outcome === 'WIN' ? 'outcome-win'
      : outcome === 'LOSS' ? 'outcome-loss' : 'outcome-pending';
    const dir = t.direction || '--';
    const dcls = dir === 'UP' ? 'badge-up' : 'badge-down';
    const pnl = Number(t.pnl || 0);
    const pnlCls = pnl > 0 ? 'outcome-win' : pnl < 0 ? 'outcome-loss' : 'text-dim';
    const tf = t.timeframe || '5m';
    // Mode column: the trade row's `shadow` flag is authoritative; fall
    // back to the `mode` string field on pre-shadow-column rows. This
    // disambiguates the per-row source so a mixed feed (BTC live,
    // others shadow) reads correctly.
    const isShadow = t.shadow === true || String(t.mode || '').toLowerCase() === 'shadow';
    const modeBadge = isShadow
      ? '<span class="mode-badge badge-shadow">SHADOW</span>'
      : '<span class="mode-badge badge-live">LIVE</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-dim">${fmtLocalTime(t.timestamp)}</td>
      <td>${t.asset || '--'} ${modeBadge}</td>
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
    // loadSummary sets shadow pane visibility; shadow trades fetch
    // keys off that visibility, so run summary first then fan out.
    await loadSummary();
    await Promise.all([
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

initBot();
bindControls();
loadMe().then(() => {
  refreshAll();
  setInterval(refreshAll, POLL_INTERVAL_MS);
});

// Ambient chatter: first line after 3s, then every 10s.
setTimeout(botAmbient, 3000);
setInterval(botAmbient, 10000);
