// ═══════════════════════════════════════════════════════════
// PolyBot Dashboard — UX rework 2026-04-23
// Monitor/Pilot/Expert modes, hero hierarchy, time-range control,
// live-vs-shadow delta, filter+sort trades, mobile sticky stop.
// ═══════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 3000;

// ─── Helpers ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => (root || document).querySelectorAll(sel);

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
    return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  } catch { return iso.slice(11, 19); }
};

async function api(path) {
  const res = await fetch(path, { credentials: 'include' });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('unauth'); }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// Wilson score interval for binomial — gives 95% CI bounds for WR.
function wilsonCI(wins, n, z = 1.96) {
  if (n <= 0) return [0, 1];
  const p = wins / n;
  const denom = 1 + (z*z)/n;
  const center = (p + (z*z)/(2*n)) / denom;
  const margin = (z * Math.sqrt((p*(1-p) + (z*z)/(4*n)) / n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ─── Mode toggle (Monitor / Pilot / Expert) ─────────────────
// Persisted in localStorage. Drives CSS visibility via body class.
const MODES = ['monitor', 'pilot', 'expert'];
function getMode() {
  const m = localStorage.getItem('polybot_mode') || 'monitor';
  return MODES.includes(m) ? m : 'monitor';
}
function setMode(m) {
  if (!MODES.includes(m)) return;
  localStorage.setItem('polybot_mode', m);
  applyMode();
  audit(`mode → ${m.toUpperCase()}`);
  if (m !== 'monitor') {
    // Promote a safety-aware operator feel with a subtle face tweak.
    claudeBlink();
  }
  if ($('modeText')) $('modeText').textContent = {
    monitor: 'MONITOR · read-only', pilot: 'PILOT · controls live', expert: 'EXPERT · all systems',
  }[m];
  // Rebind pilot controls as they may have only just become visible.
  bindControls();
}
function applyMode() {
  const m = getMode();
  document.body.classList.remove('mode-monitor','mode-pilot','mode-expert');
  document.body.classList.add(`mode-${m}`);
  MODES.forEach(x => {
    const b = $(`mode${x[0].toUpperCase()+x.slice(1)}Btn`);
    if (b) b.classList.toggle('active', x === m);
  });
  if ($('mobileMode')) $('mobileMode').textContent = m.toUpperCase();
}

// ─── Time range ─────────────────────────────────────────────
// Client-side windowing — server still returns the full set, we filter.
// Wallet and heartbeat are exempt (always instantaneous).
const RANGES = ['today','24h','7d','run','all'];
function getRange() {
  const r = localStorage.getItem('polybot_range') || 'today';
  return RANGES.includes(r) ? r : 'today';
}
function setRange(r) {
  if (!RANGES.includes(r)) return;
  localStorage.setItem('polybot_range', r);
  document.body.classList.remove(...RANGES.map(x => `range-${x}`));
  document.body.classList.add(`range-${r}`);
  if ($('timeRangeSel')) $('timeRangeSel').value = r;
  audit(`range → ${r}`);
  refreshAll();
}
function rangeStartMs() {
  const r = getRange();
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  if (r === '24h') return now - day;
  if (r === '7d')  return now - 7 * day;
  if (r === 'run') {
    const iso = window.__lastSummary?.status?.shadow_run_start_utc;
    return iso ? new Date(iso).getTime() : now - day;
  }
  if (r === 'all') return 0;
  // today: local midnight — matches server's today P&L window.
  const d = new Date(); d.setHours(0,0,0,0); return d.getTime();
}
function withinRange(iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= rangeStartMs();
}

// ─── Audit trail (action log in footer card) ────────────────
const _audit = [];
function audit(msg) {
  const ts = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  _audit.unshift({ ts, msg });
  const el = $('auditTrail');
  if (!el) return;
  if (_audit.length > 30) _audit.length = 30;
  el.innerHTML = _audit.length
    ? _audit.map(a => `<div class="audit-row"><span class="audit-ts">${a.ts}</span>${a.msg}</div>`).join('')
    : '<div class="text-dim">no actions this session</div>';
}

// ─── Me / Logout ────────────────────────────────────────────
async function loadMe() {
  try {
    const me = await api('/api/me');
    if ($('usernameTag')) $('usernameTag').textContent = me.username.toUpperCase();
    if ($('mobileUser'))  $('mobileUser').textContent = me.username.toUpperCase();
  } catch { window.location.href = '/login'; }
}
function doLogout() {
  return fetch('/api/logout', { method: 'POST', credentials: 'include' })
    .then(() => { window.location.href = '/login'; });
}

// ─── Local Clock + SYNC ticker ──────────────────────────────
let _lastStatusMs = null;
setInterval(() => {
  const now = new Date();
  const local = now.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const utc = now.toISOString().slice(11, 19) + 'Z';
  const clk = $('localTime');
  if (clk) {
    clk.textContent = `${local} · ${utc}`;
    clk.title = 'local · UTC';
  }
  if ($('mobileClock')) $('mobileClock').textContent = `${local} · ${utc}`;

  // SYNC staleness tag
  if (_lastStatusMs) {
    const age = Math.max(0, Math.floor((Date.now() - _lastStatusMs) / 1000));
    const el = $('lastUpdate'), tag = $('lastUpdateTag');
    if (!el) return;
    const mobileSync = $('mobileSync');
    let txt;
    if (age < 10) { txt = `${age}s`; tag?.classList.remove('stale'); tag?.classList.add('fresh'); }
    else if (age < 60) { txt = `${age}s`; tag?.classList.remove('fresh','stale'); }
    else if (age < 600) { txt = `${Math.floor(age/60)}m ${age%60}s`; tag?.classList.remove('fresh'); tag?.classList.add('stale'); }
    else { txt = `${Math.floor(age/60)}m`; tag?.classList.remove('fresh'); tag?.classList.add('stale'); }
    el.textContent = txt;
    if (mobileSync) mobileSync.textContent = txt;
  }
}, 1000);

// ─── Heartbeat-age formatter (used in multiple places) ──────
function fmtAge(sec) {
  if (sec == null) return '--';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}m ${s}s`;
}

// ─── Summary Renderer ──────────────────────────────────────
async function loadSummary() {
  // Bachelier pane scoping: every existing widget on the right pane reads
  // the bachelier bot's data only. Combined totals come from the new
  // /api/combined_summary call (loadCombined).
  const s = await api('/api/summary?bot_type=bachelier');
  window.__lastSummary = s;
  claudeSetStatus('loaded');

  // Heartbeat freshness
  const syncIso = s.status?.updated_at;
  if (syncIso) { try { _lastStatusMs = new Date(syncIso).getTime(); } catch {} }
  const ageSec = (s.heartbeat?.age_sec != null) ? Number(s.heartbeat.age_sec) : null;
  const fresh  = !!s.heartbeat?.is_fresh;
  const running = !!s.status?.running;
  const halts  = Array.isArray(s.status?.killswitches) ? s.status.killswitches : [];
  const globalHalt = halts.some(h => [1,3,4,5].includes(Number(h.rail_id)));
  const shadow = !!s.status?.shadow_mode;

  let state = 'UNKNOWN';
  if (!running) state = 'OFFLINE';
  else if (!fresh) state = 'STALE';
  else if (globalHalt) state = 'HALTED';
  else state = shadow ? 'SHADOW' : 'LIVE';

  // Top-bar status pill
  $('statusDot').className = 'status-dot' + (state === 'LIVE' || state === 'SHADOW' ? '' : ' offline');
  $('statusText').textContent = state;
  if ($('modeText')) $('modeText').textContent = shadow ? 'SHADOW MODE' : (getMode() === 'monitor' ? 'MONITOR · read-only' : 'LIVE TRADING');

  renderStateBanner(state, ageSec, halts, s);

  // Consolidated bot-status card
  if ($('botStateTxt')) {
    $('botStateTxt').textContent = state;
    $('botStateTxt').className = state === 'LIVE' || state === 'SHADOW' ? 'text-green' :
                                 state === 'HALTED' ? 'text-red' :
                                 state === 'STALE' ? 'text-amber' : 'text-dim';
  }
  if ($('heartbeatAge')) $('heartbeatAge').textContent = fmtAge(ageSec);
  if ($('uptimeTxt')) {
    const startIso = s.status?.started_at_utc || s.status?.shadow_run_start_utc;
    if (startIso && running) {
      const mins = Math.floor((Date.now() - new Date(startIso).getTime()) / 60000);
      const h = Math.floor(mins/60), m = mins % 60;
      $('uptimeTxt').textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
    } else {
      $('uptimeTxt').textContent = running ? '—' : 'offline';
    }
  }

  // ── HERO: Today's P&L ─────────────────────────────────
  const today = Number(s.pnl?.today || 0);
  const heroEl = $('heroTodayPnl');
  if (heroEl) {
    heroEl.textContent = fmtUsd(today);
    heroEl.className = 'stat-hero ' + (today > 0 ? '' : today < 0 ? 'neg' : 'neutral');
  }
  const nToday = Number(s.wins_today || 0) + Number(s.losses_today || 0);
  if ($('heroTodaySub')) {
    $('heroTodaySub').textContent = nToday > 0
      ? `${nToday} resolved today · ${s.wins_today || 0}W / ${s.losses_today || 0}L`
      : 'no trades today yet';
  }

  // Wallet
  const onchain = (s.wallet?.onchain_usdc != null) ? Number(s.wallet.onchain_usdc) : null;
  const heartbeatBal = Number(s.wallet?.heartbeat_usdc || 0);
  const walletBal = onchain != null ? onchain : (heartbeatBal > 0 ? heartbeatBal : null);
  const walletEl = $('walletBal');
  if (walletEl) {
    if (walletBal != null) {
      walletEl.textContent = `$${walletBal.toFixed(2)}`;
      walletEl.className = 'stat-big ' + (today >= 0 ? 'pos' : 'neutral');
    } else {
      walletEl.textContent = '$--';
      walletEl.className = 'stat-big text-dim';
    }
  }
  if ($('walletSub')) {
    const src = onchain != null ? 'on-chain' : (heartbeatBal > 0 ? 'heartbeat (RPC unreachable)' : '--');
    $('walletSub').textContent = `USDC.e ${src}`;
  }
  if ($('walletDelta')) {
    // vs start-of-day: use (wallet - today_pnl) as proxy for SOD balance —
    // not exact if deposits happened mid-day, but good enough for monitoring.
    const sodBal = walletBal != null ? (walletBal - today) : null;
    if (sodBal != null) {
      const delta = walletBal - sodBal;
      const pct = sodBal > 0 ? (delta / sodBal) * 100 : 0;
      const cls = delta >= 0 ? 'text-green' : 'text-red';
      $('walletDelta').innerHTML = `<span class="${cls}">${fmtUsd(delta)} (${pct.toFixed(1)}%)</span> vs SOD`;
    } else {
      $('walletDelta').textContent = '';
    }
  }

  // WR with Wilson CI
  const wrOverall = Number(s.win_rate?.overall || 0.5);
  const winsTotal = Number(s.trades?.wins || 0);
  const lossesTotal = Number(s.trades?.losses || 0);
  const nResolved = winsTotal + lossesTotal;
  const [lo, hi] = wilsonCI(winsTotal, nResolved);
  const wrEl = $('winRate');
  wrEl.textContent = fmtPct(wrOverall);
  wrEl.className = 'stat-big ' + (wrOverall >= 0.55 ? 'pos' : wrOverall >= 0.48 ? 'neutral' : 'neg');
  if ($('winRateSub')) {
    $('winRateSub').textContent = nResolved > 0
      ? `95% CI ${fmtPct(lo)}–${fmtPct(hi)} · n=${nResolved}`
      : 'no resolved trades';
  }

  // Heartbeat-derived panels
  renderDailyCap(s);
  renderCalibration(s.status || {});
  renderTierLadder(s.status || {});
  renderScanCount(s.status || {});
  renderWsStatus(s.status || {}, fresh, running);
  renderRailsStrip(halts, s.status || {}, fresh, running);
  renderRailsDetail(halts, s.status || {}, fresh, running);
  renderRailTimeline(halts, s.status || {});
  renderNearMiss(s.status || {});
  renderAssetRoster(s.status || {});
  renderPositions(s.status || {});
  renderClaudeFace(state, running);

  // Cycle timer
  renderTimer(s.status || {});

  // Next-cycle label in consolidated card (kept because operators want it)
  // (no separate cycleLabel element now — compact)

  // Control state derived from bot_control table
  let ctrl = (s.control_state || '').toLowerCase();
  if (!ctrl) ctrl = (s.status?.control_state || '').toLowerCase();
  if (ctrl === 'paused' || ctrl === 'pause') applyControlState('pause');
  else applyControlState('start');
}

// ─── State Banner ──────────────────────────────────────────
function renderStateBanner(state, ageSec, halts, s) {
  const el = $('stateBanner');
  if (!el) return;
  const ageTxt = ageSec == null ? '--' : fmtAge(ageSec);
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

// ─── Rails strip (compact 5-dot) + expandable detail ───────
const RAIL_META = [
  { id: 1, name: 'Consecutive red days',  short: 'R1' },
  { id: 2, name: 'Cell WR drift',          short: 'R2' },
  { id: 3, name: 'Intraday drawdown 40%',  short: 'R3' },
  { id: 4, name: 'Slippage doubling',      short: 'R4' },
  { id: 5, name: 'Daily loss cap',         short: 'R5' },
];
function renderRailsStrip(halts, status, fresh, running) {
  const wrap = $('railsStrip');
  if (!wrap) return;
  const byId = new Map(halts.map(h => [Number(h.rail_id), h]));
  wrap.innerHTML = '';
  let anyFired = false;
  RAIL_META.forEach(r => {
    const halt = byId.get(r.id);
    let cls = 'rail-strip-cell', titleExt = 'armed';
    if (halt) {
      const cooling = halt.action === 'cooldown' || halt.action === 'cooling';
      cls += cooling ? ' cooling' : ' fired';
      titleExt = cooling ? 'cooling' : 'FIRED';
      if (!cooling) anyFired = true;
    } else if (!running || !fresh) {
      cls += ' stale'; titleExt = 'unknown';
    }
    const cell = document.createElement('div');
    cell.className = cls;
    cell.title = `${r.short} · ${r.name} — ${titleExt}`;
    cell.innerHTML = `<span class="rail-strip-dot"></span><span class="rail-strip-label">${r.short}</span>`;
    cell.addEventListener('click', () => toggleRailsDetail(true));
    wrap.appendChild(cell);
  });
  // Auto-expand when any rail is actually fired (not just cooling).
  if (anyFired) toggleRailsDetail(true);
}
function renderRailsDetail(halts, status, fresh, running) {
  const wrap = $('railsGrid');
  if (!wrap) return;
  const byId = new Map(halts.map(h => [Number(h.rail_id), h]));
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
      <div class="rail-head"><span class="rail-num">${r.short} · RAIL ${r.id}</span><span class="rail-state">${label}</span></div>
      <div class="rail-name">${r.name}</div>
      <div class="rail-detail">${detail}</div>
    `;
    wrap.appendChild(div);
  });
}
function toggleRailsDetail(force) {
  const det = $('railsDetail');
  const btn = $('railsToggleBtn');
  if (!det) return;
  const show = force !== undefined ? force : det.style.display === 'none';
  det.style.display = show ? 'block' : 'none';
  if (btn) btn.textContent = show ? 'collapse' : 'expand';
}

// ─── Rail fire timeline (recent fires) ─────────────────────
function renderRailTimeline(halts, status) {
  const el = $('railTimeline');
  if (!el) return;
  // Build from active halts + single last-event. A full history endpoint
  // would live server-side (NEEDS-MAIN-BOT to expose kill_switch_events table).
  const items = [];
  halts.forEach(h => {
    items.push({
      iso: h.fired_at_utc || h.fired_at || '',
      rail: h.rail_name || `rail ${h.rail_id}`,
      detail: h.details ? JSON.stringify(h.details).slice(0, 80) : h.action || '',
      scope: h.cell ? h.cell.join('/') : 'global',
    });
  });
  if (status.killswitch_event) {
    const e = status.killswitch_event;
    items.push({
      iso: e.fired_at_utc || '',
      rail: e.rail_name || `rail ${e.rail_id}`,
      detail: (e.details ? JSON.stringify(e.details).slice(0, 80) : '') || e.explanation || e.action || '',
      scope: e.cell ? (Array.isArray(e.cell) ? e.cell.join('/') : String(e.cell)) : 'global',
    });
  }
  // Dedupe by iso+rail, sort desc.
  const seen = new Set();
  const unique = items.filter(i => {
    const k = `${i.iso}|${i.rail}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).sort((a,b) => (b.iso || '').localeCompare(a.iso || ''));

  if (!unique.length) {
    el.innerHTML = '<div class="text-dim empty-claude"><span class="claude-face tiny"></span> no rails fired today.</div>';
    return;
  }
  el.innerHTML = unique.slice(0, 12).map(it => {
    const at = it.iso ? new Date(it.iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '--';
    return `
      <div class="rail-timeline-item">
        <span class="rail-timeline-time">${at}</span>
        <span class="rail-timeline-rail">${it.rail} <span class="text-dim" style="font-weight:400;">· ${it.scope}</span></span>
        <span class="rail-timeline-detail">${it.detail || ''}</span>
      </div>
    `;
  }).join('');
  el.insertAdjacentHTML('beforeend',
    '<div class="stat-sub" style="color:var(--amber); margin-top:6px;">NEEDS-MAIN-BOT: expose kill_switch_events table for full history.</div>');
}

// ─── Near-miss counter (heartbeat-sourced) ────────────────
function renderNearMiss(status) {
  const el = $('nearMissBlock');
  if (!el) return;
  const nm = status.interim_report?.near_miss_per_gate || status.near_miss_per_gate;
  if (!nm || !Object.keys(nm).length) {
    el.innerHTML = `
      <div class="stat-sub">No near-miss data in heartbeat yet.</div>
      <div class="stat-sub" style="color:var(--amber); margin-top:10px;">NEEDS-MAIN-BOT: push near-miss rollup in status.near_miss_per_gate.</div>
    `;
    return;
  }
  const total = Object.values(nm).reduce((a, g) => a + Number(g.n || 0), 0);
  const rows = Object.entries(nm).map(([gate, s]) =>
    `<div class="flex flex-between" style="font-size:0.78rem;"><span class="text-dim">${gate}</span><span>${s.n}t · ${fmtPct(s.wr || 0)}</span></div>`
  ).join('');
  el.innerHTML = `
    <div class="nm-big">${total}</div>
    <div class="stat-sub">trades almost fired · rejected by gate</div>
    <div class="nm-breakdown">${rows}</div>
  `;
}

// ─── Daily Cap thermometer + slider ─────────────────────
function renderDailyCap(s) {
  const fill = $('dailyCapFill');
  const used = $('dailyCapUsed');
  const total = $('dailyCapTotal');
  const note = $('dailyCapNote');
  if (!fill) return;
  const today = Number(s.pnl?.today || 0);
  const loss = today < 0 ? -today : 0;
  const wallet = Number(s.wallet?.onchain_usdc || s.wallet?.heartbeat_usdc || 0);
  const pilot = Number(s.status?.rail5_pilot_ticket_usd || 5);
  const avgTicket = Number(s.status?.avg_ticket_today_usd || pilot);
  const mult = Math.max(1.0, avgTicket / Math.max(pilot, 1e-6));
  const autoCap = Math.max(50 * mult, 0.05 * wallet);
  // If user has an override queued, show that alongside
  const override = Number(localStorage.getItem('polybot_cap_override') || 0);
  const absCap = override > 0 ? override : autoCap;
  const pct = Math.min(100, (loss / Math.max(absCap, 1)) * 100);
  fill.style.width = `${pct.toFixed(1)}%`;
  fill.className = 'thermo-fill ' + (pct >= 90 ? 'hot' : pct >= 60 ? 'warm' : 'cool');
  used.textContent = loss > 0 ? `loss $${loss.toFixed(2)}` : `P&L ${fmtUsd(today)}`;
  total.textContent = `cap $${absCap.toFixed(0)}` + (override > 0 ? ' (override)' : '');
  note.textContent = `rail 5 · mult ${mult.toFixed(2)}× · 5% of $${wallet.toFixed(0)} wallet`;
}

// ─── Calibration ──────────────────────────────────────────
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
  const sigmaRows = Object.keys(sigma).sort().map(k =>
    `<tr><td class="text-dim">${k}</td><td class="td-num">${Number(sigma[k]).toFixed(2)}×</td></tr>`
  ).join('');
  const gatesList = (activeGates.length ? activeGates : ['(none reported)'])
    .map(g => `<span class="gate-chip">${g}</span>`).join(' ');
  el.innerHTML = `
    <div class="flex" style="gap:18px; flex-wrap:wrap;">
      <div style="flex:1; min-width:160px;">
        <div class="card-section-label">σ per asset</div>
        <table class="mini-table">${sigmaRows || '<tr><td class="text-dim" colspan="2">--</td></tr>'}</table>
      </div>
      <div style="flex:1; min-width:160px;">
        <div class="card-section-label">α (market blend)</div>
        <div class="stat-med" style="color:var(--green-bright);">${alpha != null ? Number(alpha).toFixed(2) : '--'}</div>
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

// ─── Tier Ladder ──────────────────────────────────────────
function renderTierLadder(status) {
  const el = $('tierBlock');
  if (!el) return;
  const tiers = Array.isArray(status.tier_ladder) ? status.tier_ladder : [];
  if (!tiers.length) {
    el.innerHTML = '<div class="text-dim">no live cells yet (tier ladder empty until first live fill)</div>';
    return;
  }
  const rows = tiers.map((c, i) => {
    const shadowDelta = (c.live_wr != null && c.shadow_wr != null)
      ? ((Number(c.live_wr) - Number(c.shadow_wr)) * 100).toFixed(1) + 'pp'
      : '--';
    const pct = Math.min(100, ((c.live_n || 0) / Math.max(c.n_required || 1, 1)) * 100);
    const cls = shadowDelta.startsWith('-') ? 'text-red' : 'text-green';
    const tierCell = document.body.classList.contains('mode-expert')
      ? `<span class="expert-tier-edit link-btn" data-cell="${i}" title="EXPERT: override tier">T${c.tier || 0}</span>`
      : `T${c.tier || 0}`;
    return `
      <tr>
        <td>${c.asset || '?'}/${c.timeframe || '?'}</td>
        <td class="td-num">${tierCell}</td>
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
    </table>
    <div class="stat-sub expert-only" style="color:var(--amber); margin-top:6px;">NEEDS-MAIN-BOT: per-cell tier override endpoint.</div>
  `;
  // Wire expert-mode tier click
  $$('.expert-tier-edit', el).forEach(sp => {
    sp.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmAction({
        title: 'TIER OVERRIDE',
        body: `Override tier for cell ${sp.closest('tr').cells[0].textContent} — NOT WIRED to bot-side API.`,
        onConfirm: () => audit(`tier-override-click cell=${sp.closest('tr').cells[0].textContent} (no-op)`),
      });
    });
  });
}

// ─── Scan count ───────────────────────────────────────────
function renderScanCount(status) {
  const el = $('scanCount');
  if (!el) return;
  const n = status.scan_count ?? status.cycle_number ?? null;
  el.textContent = n != null ? String(n) : '--';
}

// ─── WS status light ──────────────────────────────────────
function renderWsStatus(status, fresh, running) {
  const dot = $('wsDot');
  const txt = $('wsText');
  if (!dot || !txt) return;
  const cl = status.chainlink_ws || {};
  const connected = cl.connected ?? status.chainlink_connected;
  const reconnecting = cl.reconnecting ?? status.chainlink_reconnecting;
  if (!running || !fresh) { dot.className = 'ws-dot off'; txt.textContent = 'unknown'; }
  else if (reconnecting)   { dot.className = 'ws-dot warn'; txt.textContent = 'reconnecting…'; }
  else if (connected === false) { dot.className = 'ws-dot off'; txt.textContent = 'disconnected'; }
  else { dot.className = 'ws-dot ok'; txt.textContent = 'connected'; }
}

// ─── Positions ────────────────────────────────────────────
function renderPositions(status) {
  const positions = Array.isArray(status.positions) ? status.positions : [];
  const body = $('positionsTable')?.querySelector('tbody');
  if (!body || !$('posCount')) return;

  if (!positions.length) {
    body.innerHTML = '<tr><td colspan="7" class="text-dim empty-claude"><span class="claude-face tiny"></span> idle — waiting for signal.</td></tr>';
    $('posCount').textContent = '0';
    $('posStatusBreakdown').textContent = 'no positions';
    $('posCost').textContent = '$--'; $('posCurVal').textContent = '$--'; $('posUnreal').textContent = '$--';
    $('posUnreal').className = 'stat-med';
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
    totalCost += shares * avg;
    totalCur += cv;
    const stat = p.status || 'LIVE';
    statusCounts[stat] = (statusCounts[stat] || 0) + 1;
    const statCls = stat === 'WIN' ? 'outcome-win' : stat === 'LOSS' ? 'outcome-loss' : stat === 'LIVE' ? 'text-amber' : 'text-dim';
    const pnlCls = pnl > 0 ? 'outcome-win' : pnl < 0 ? 'outcome-loss' : 'text-dim';
    const dir = String(p.outcome || '').toUpperCase();
    const dcls = dir === 'UP' ? 'badge-up' : 'badge-down';
    const rawTitle = p.title || p.slug || '--';
    const shortTitle = rawTitle.replace(/^(Bitcoin|Ethereum|Solana|Dogecoin|XRP|Avalanche|Chainlink)\s+Up or Down\s+/i, '').slice(0, 52);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${shortTitle}</td>
      <td class="${dcls}">${dir || '--'}</td>
      <td class="td-num">${shares.toFixed(2)}</td>
      <td class="td-num">$${avg.toFixed(3)}</td>
      <td class="td-num">$${cv.toFixed(2)}</td>
      <td class="td-num ${pnlCls}">${fmtUsd(pnl)}</td>
      <td class="${statCls}">${stat}</td>`;
    body.appendChild(tr);
  });
  const totalPnl = totalCur - totalCost;
  $('posCount').textContent = String(positions.length);
  $('posStatusBreakdown').textContent = `${statusCounts.LIVE} live · ${statusCounts.WIN} win · ${statusCounts.LOSS} loss`;
  $('posCost').textContent = `$${totalCost.toFixed(2)}`;
  $('posCurVal').textContent = `$${totalCur.toFixed(2)}`;
  $('posUnreal').textContent = fmtUsd(totalPnl);
  $('posUnreal').className = 'stat-med ' + (totalPnl > 0 ? 'pos' : totalPnl < 0 ? 'neg' : '');
}

// ─── Timer (minimal — now lives in consolidated status card) ─
let _cycleTimerInterval = null;
function renderTimer(status) {
  if (_cycleTimerInterval) clearInterval(_cycleTimerInterval);
  const nextCycleIso = status.next_cycle_at;
  const running = !!status.running;
  const el = $('cycleTimer');
  if (!el) return;
  if (!nextCycleIso) { el.textContent = running ? 'idle' : 'offline'; return; }
  const targetMs = new Date(nextCycleIso).getTime();
  const tick = () => {
    const diff = Math.max(0, Math.floor((targetMs - Date.now()) / 1000));
    const m = Math.floor(diff / 60), s = diff % 60;
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };
  tick();
  _cycleTimerInterval = setInterval(tick, 1000);
}

// ─── LIVE/SHADOW helpers ──────────────────────────────────
function liveAssets() {
  const s = window.__lastSummary || {};
  const la = s.status?.live_assets;
  if (Array.isArray(la) && la.length) return new Set(la.map(a => String(a).toUpperCase()));
  return new Set(['BTC']); // matches CLAUDE.md default
}

// ─── Per-asset WR ─────────────────────────────────────────
async function loadAssets() {
  const data = await api('/api/per_asset?bot_type=bachelier');
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
    const asset = String(a.asset || '').toUpperCase();
    const isLive = liveSet.has(asset);
    const badgeHtml = `<span class="mode-badge ${isLive ? 'badge-live' : 'badge-shadow'}">${isLive ? 'LIVE' : 'SHADOW'}</span>`;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${asset} ${badgeHtml}</div>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%">${pct}%</div></div>
      <div class="bar-val">${a.total}t ${fmtUsd(a.pnl)}</div>`;
    container.appendChild(row);
  });
}

// ─── WR by Timeframe ─────────────────────────────────────
async function loadTimeframes() {
  const data = await api('/api/wr_by_timeframe?bot_type=bachelier');
  const container = $('timeframeList');
  if (!data.length) { container.innerHTML = '<div class="text-dim">no data yet</div>'; return; }
  container.innerHTML = '';
  data.forEach(tf => {
    const pct = Math.round(tf.win_rate * 100);
    const cls = tf.win_rate >= 0.55 ? 'good' : tf.win_rate >= 0.45 ? 'mid' : 'bad';
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${tf.timeframe}</div>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%">${pct}%</div></div>
      <div class="bar-val">${tf.wins}/${tf.total}</div>`;
    container.appendChild(row);
  });
}

// ─── Hourly ─────────────────────────────────────────────
let _hourlySort = 'hour';
async function loadHourly() {
  const data = await api('/api/hourly?bot_type=bachelier');
  const container = $('hourlyList');
  if (!data.length) { container.innerHTML = '<div class="text-dim">no data yet</div>'; return; }
  const filtered = data.filter(h => h.total >= 3);
  if (!filtered.length) { container.innerHTML = '<div class="text-dim">need more samples</div>'; return; }
  const sorted = _hourlySort === 'wr'
    ? [...filtered].sort((a,b) => b.win_rate - a.win_rate)
    : [...filtered].sort((a,b) => a.hour - b.hour);
  container.innerHTML = '';
  sorted.slice(0, 12).forEach(h => {
    const pct = Math.round(h.win_rate * 100);
    const cls = h.win_rate >= 0.60 ? 'good' : h.win_rate >= 0.45 ? 'mid' : 'bad';
    const localHour = _utcHourToLocal(h.hour);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-label">${String(localHour).padStart(2,'0')}:00 <span class="text-dim" style="font-size:0.65rem;">${String(h.hour).padStart(2,'0')}z</span></div>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%">${pct}%</div></div>
      <div class="bar-val">${h.wins}/${h.total}</div>`;
    container.appendChild(row);
  });
}
function _utcHourToLocal(h) { const d = new Date(); d.setUTCHours(h,0,0,0); return d.getHours(); }

// ─── Live vs Shadow delta panel ──────────────────────────
// Derived entirely from /api/trades — per-asset, WR live vs shadow.
// Color: green within 3pp, amber 3-5pp, red >5pp. This is the #1
// live-flip trust signal per the brief.
async function loadLiveVsShadow() {
  const el = $('lvsBlock');
  if (!el) return;
  try {
    const rows = await api('/api/trades?limit=500&bot_type=bachelier');
    const start = rangeStartMs();
    const inRange = rows.filter(r => {
      const t = r.timestamp ? new Date(r.timestamp).getTime() : 0;
      return t >= start && (r.outcome === 'WIN' || r.outcome === 'LOSS');
    });
    const byAsset = {};
    inRange.forEach(r => {
      const a = r.asset || '?';
      const isShadow = r.shadow === true || String(r.mode || '').toLowerCase() === 'shadow';
      const bucket = byAsset[a] || (byAsset[a] = { live: { n:0, w:0 }, shadow: { n:0, w:0 } });
      const side = isShadow ? bucket.shadow : bucket.live;
      side.n += 1;
      if (r.outcome === 'WIN') side.w += 1;
    });
    const entries = Object.entries(byAsset).sort((a,b) => a[0].localeCompare(b[0]));
    if (!entries.length) {
      el.innerHTML = '<div class="text-dim empty-claude"><span class="claude-face tiny"></span> no trades in range.</div>';
      return;
    }
    const body = entries.map(([a, st]) => {
      const lwr = st.live.n ? st.live.w / st.live.n : null;
      const swr = st.shadow.n ? st.shadow.w / st.shadow.n : null;
      const delta = (lwr != null && swr != null) ? (lwr - swr) * 100 : null;
      const dTxt = delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp`;
      const dCls = delta == null ? '' : Math.abs(delta) < 3 ? 'delta-ok' : Math.abs(delta) < 5 ? 'delta-warn' : 'delta-bad';
      const [llo, lhi] = lwr != null ? wilsonCI(st.live.w, st.live.n) : [0, 0];
      const [slo, shi] = swr != null ? wilsonCI(st.shadow.w, st.shadow.n) : [0, 0];
      return `
        <tr class="lvs-row">
          <td>${a}</td>
          <td>${st.live.n ? `${st.live.n}t · ${fmtPct(lwr)}` : '—'}</td>
          <td class="text-dim">${st.live.n ? `CI ${fmtPct(llo)}–${fmtPct(lhi)}` : ''}</td>
          <td>${st.shadow.n ? `${st.shadow.n}t · ${fmtPct(swr)}` : '—'}</td>
          <td class="text-dim">${st.shadow.n ? `CI ${fmtPct(slo)}–${fmtPct(shi)}` : ''}</td>
          <td class="${dCls}">${dTxt}</td>
        </tr>`;
    }).join('');
    el.innerHTML = `
      <table class="lvs-table">
        <thead><tr><th>asset</th><th>live</th><th>live CI</th><th>shadow</th><th>shadow CI</th><th>Δ (live − shadow)</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="stat-sub" style="margin-top:6px;">Δ within ±3pp = pipeline honest · 3–5pp = watch · &gt;5pp = investigate before promoting.</div>
    `;

    // Top-row live-shadow delta summary for the Live WR card
    const lvsSum = $('liveShadowDelta');
    if (lvsSum) {
      const liveAgg = entries.reduce((a, [, st]) => ({ n: a.n + st.live.n, w: a.w + st.live.w }), { n:0, w:0 });
      const shadowAgg = entries.reduce((a, [, st]) => ({ n: a.n + st.shadow.n, w: a.w + st.shadow.w }), { n:0, w:0 });
      if (shadowAgg.n && liveAgg.n) {
        const d = (liveAgg.w / liveAgg.n - shadowAgg.w / shadowAgg.n) * 100;
        const cls = Math.abs(d) < 3 ? 'text-green' : Math.abs(d) < 5 ? 'text-amber' : 'text-red';
        lvsSum.innerHTML = `shadow ${fmtPct(shadowAgg.w/shadowAgg.n)} · <span class="${cls}">Δ ${d>=0?'+':''}${d.toFixed(1)}pp</span>`;
      } else if (shadowAgg.n) {
        lvsSum.innerHTML = `shadow ${fmtPct(shadowAgg.w/shadowAgg.n)} · no live yet`;
      } else if (liveAgg.n) {
        lvsSum.textContent = `live only — no shadow comparison`;
      } else {
        lvsSum.textContent = '';
      }
    }
  } catch (e) {
    el.innerHTML = `<div class="text-red">error: ${e.message || e}</div>`;
  }
}

// ─── Asset Roster (PILOT) ─────────────────────────────────
function renderAssetRoster(status) {
  const el = $('assetRoster');
  if (!el) return;
  const allAssets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
  const liveSet = liveAssets();
  el.innerHTML = allAssets.map(a => `
    <div class="roster-row">
      <span>${a}</span>
      <label class="roster-toggle disabled" title="NEEDS-MAIN-BOT endpoint to toggle at runtime">
        <input type="checkbox" ${liveSet.has(a) ? 'checked' : ''} disabled data-asset="${a}">
        <span></span>
      </label>
    </div>
  `).join('');
}

// ─── Strategy Comparison (CORE vs EARLY) ────────────────────────
// Wilson 95% CI — standard score interval. Much better than the naive
// sqrt(p*(1-p)/n) at small n and near 0/1, which is exactly the regime
// a brand-new early_entry strategy will spend most of its first week in.
function wilson95(w, n) {
  if (n <= 0) return [0, 0];
  const z = 1.96;
  const p = w / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) / n) + (z * z) / (4 * n * n));
  const lo = (center - margin) / denom;
  const hi = (center + margin) / denom;
  // Clamp to [0, 1] - numerical drift at the 0/n and n/n edges can produce
  // values like -1e-17 or 1.0000000001 that would render as '-0.0%' / '100.0%'.
  return [Math.max(0, lo), Math.min(1, hi)];
}

function _fmtPF(b) {
  if (b.profit_factor != null) return Number(b.profit_factor).toFixed(2);
  // Server returns null for 'no losses' — the client disambiguates using
  // the W/L counts so a strategy with wins and zero losses reads as ∞
  // rather than the same '--' we use for 'no data at all'.
  if (Number(b.l) === 0 && Number(b.w) > 0) return '∞';
  return '--';
}
function _fmtWilson(w, n) {
  if (!n) return '--';
  const [lo, hi] = wilson95(Number(w), Number(n));
  return `${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%`;
}
// Format the SCALP-only trigger breakdown as 'TP 50% · SL 25% · TIME 12% · RES 12%'.
// Buckets that are 0 are omitted so a fresh strategy doesn't read as four zeros.
function _fmtTriggers(triggers) {
  if (!triggers) return '--';
  const order = [['take_profit', 'TP'], ['stop_loss', 'SL'], ['time_exit', 'TIME'], ['resolution', 'RES'], ['other', 'OTHER']];
  const total = order.reduce((s, [k]) => s + (Number(triggers[k]) || 0), 0);
  if (!total) return '--';
  const parts = [];
  for (const [k, label] of order) {
    const c = Number(triggers[k]) || 0;
    if (!c) continue;
    parts.push(`${label} ${Math.round((c / total) * 100)}%`);
  }
  return parts.join(' · ');
}
function _strategyCol(b, label, colClass) {
  const net = Number(b.net_pnl || 0);
  const netCls = net > 0 ? 'pnl-pos' : net < 0 ? 'pnl-neg' : '';
  const wrTxt = b.n ? `${(Number(b.wr) * 100).toFixed(1)}%` : '--';
  const askTxt = b.mean_ask ? `$${Number(b.mean_ask).toFixed(3)}` : '--';
  // Trigger breakdown is only meaningful for the SCALP column. Server returns
  // .triggers only on scalp_exit; check for it here so this helper stays
  // generic for the other two columns.
  const trigBlock = b.triggers
    ? `<div class="strategy-trig-row">
         <span class="trig-label">exit triggers</span>
         <span class="trig-vals">${_fmtTriggers(b.triggers)}</span>
       </div>`
    : '';
  return `
    <div class="strategy-col ${colClass}">
      <div class="strategy-col-header">${label}</div>
      <div class="strategy-rows">
        <div class="strategy-row"><span>n</span><span>${b.n}</span></div>
        <div class="strategy-row"><span>w / l</span><span>${b.w} / ${b.l}</span></div>
        <div class="strategy-row"><span>wr</span><span>${wrTxt}</span></div>
        <div class="strategy-row"><span>wilson 95%</span><span>${_fmtWilson(b.w, b.n)}</span></div>
        <div class="strategy-row ${netCls}"><span>net pnl</span><span>${fmtUsd(net)}</span></div>
        <div class="strategy-row"><span>mean ask</span><span>${askTxt}</span></div>
        <div class="strategy-row"><span>profit factor</span><span>${_fmtPF(b)}</span></div>
      </div>
      ${trigBlock}
    </div>
  `;
}
async function loadStrategyCompare() {
  const el = $('strategyCompare');
  if (!el) return;
  let data;
  try {
    data = await api('/api/strategy_compare');
  } catch (e) {
    if (e.message !== 'unauth') console.warn('strategy_compare err', e);
    return;
  }
  const empty = { n: 0, w: 0, l: 0, wr: 0, net_pnl: 0, mean_ask: 0, profit_factor: null };
  const core = data.expiry_convergence || empty;
  const early = data.early_entry || empty;
  // Scalp bucket carries .triggers (always present from the server, zeros if
  // no scalp trades yet). Spread an empty triggers obj if the server somehow
  // omitted it (pre-deploy ordering edge case).
  const scalp = data.scalp_exit || { ...empty, triggers: {} };
  if (!scalp.triggers) scalp.triggers = {};
  if (!core.n && !early.n && !scalp.n) {
    el.innerHTML = '<div class="text-dim">no resolved trades yet</div>';
    return;
  }
  el.innerHTML = _strategyCol(core, 'CORE', 'col-core')
               + _strategyCol(early, 'EARLY', 'col-early')
               + _strategyCol(scalp, 'SCALP', 'col-scalp');
}

// ─── Trades: filter + sort + paginate + drill-down ─────────
let _trades = [];
let _tradesLimit = 50;
let _tradesSort = { col: 'timestamp', desc: true };
// `strategy`: '' = all, 'core' = expiry_convergence (incl legacy NULL),
// 'early' = early_entry. Filtered client-side like the other dropdowns.
let _tradesFilter = { asset: '', dir: '', outcome: '', mode: '', strategy: '', conf: '' };

async function loadTrades() {
  const limit = Math.max(_tradesLimit, 50);
  const raw = await api(`/api/trades?limit=${limit}&bot_type=bachelier`);
  _trades = raw;
  botReactToTrades(raw);
  populateFilterAssets(raw);
  renderTrades();
}
function populateFilterAssets(rows) {
  const sel = $('flAsset');
  if (!sel) return;
  const current = sel.value;
  const assets = Array.from(new Set(rows.map(r => r.asset).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">all assets</option>' +
    assets.map(a => `<option value="${a}">${a}</option>`).join('');
  sel.value = current;
}
function passFilters(t) {
  const f = _tradesFilter;
  if (f.asset && t.asset !== f.asset) return false;
  if (f.dir && t.direction !== f.dir) return false;
  if (f.outcome) {
    const o = t.outcome || 'PENDING';
    if (o !== f.outcome) return false;
  }
  if (f.mode) {
    const isShadow = t.shadow === true || String(t.mode || '').toLowerCase() === 'shadow';
    if (f.mode === 'live' && isShadow) return false;
    if (f.mode === 'shadow' && !isShadow) return false;
  }
  if (f.strategy) {
    // Legacy rows (no column / null) collapse to 'expiry_convergence' so
    // 'core only' keeps showing pre-migration data.
    const s = t.strategy_label || 'expiry_convergence';
    if (f.strategy === 'core'  && s !== 'expiry_convergence') return false;
    if (f.strategy === 'early' && s !== 'early_entry') return false;
    if (f.strategy === 'scalp' && s !== 'scalp_exit') return false;
  }
  if (f.conf) {
    const c = Number(t.confidence || 0);
    if (f.conf === 'lt50'   && !(c < 0.5)) return false;
    if (f.conf === '50to70' && !(c >= 0.5 && c < 0.7)) return false;
    if (f.conf === '70to85' && !(c >= 0.7 && c < 0.85)) return false;
    if (f.conf === 'ge85'   && !(c >= 0.85)) return false;
  }
  // Time range filter
  const t0 = t.timestamp ? new Date(t.timestamp).getTime() : 0;
  if (t0 < rangeStartMs()) return false;
  return true;
}
function renderTrades() {
  const body = $('tradesTable')?.querySelector('tbody');
  if (!body) return;
  const filtered = _trades.filter(passFilters);
  const { col, desc } = _tradesSort;
  filtered.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (col === 'timestamp') { va = new Date(va || 0).getTime(); vb = new Date(vb || 0).getTime(); }
    if (col === 'pnl' || col === 'size_usd' || col === 'confidence') { va = Number(va || 0); vb = Number(vb || 0); }
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (va < vb) return desc ? 1 : -1;
    if (va > vb) return desc ? -1 : 1;
    return 0;
  });

  const shown = filtered.slice(0, _tradesLimit);
  if ($('tradeFilterCount')) $('tradeFilterCount').textContent = `${filtered.length} rows`;
  if ($('tradesShownCount')) $('tradesShownCount').textContent = `showing ${shown.length} of ${filtered.length}`;

  if (!shown.length) {
    body.innerHTML = '<tr><td colspan="10" class="text-dim empty-claude"><span class="claude-face tiny"></span> no trades match filters.</td></tr>';
    return;
  }

  body.innerHTML = '';
  shown.forEach(t => {
    const outcome = t.outcome || 'PENDING';
    const ocls = outcome === 'WIN' ? 'outcome-win' : outcome === 'LOSS' ? 'outcome-loss' : 'outcome-pending';
    const dir = t.direction || '--';
    const dcls = dir === 'UP' ? 'badge-up' : 'badge-down';
    const pnl = Number(t.pnl || 0);
    const pnlCls = pnl > 0 ? 'outcome-win' : pnl < 0 ? 'outcome-loss' : 'text-dim';
    const tf = t.timeframe || '5m';
    const isShadow = t.shadow === true || String(t.mode || '').toLowerCase() === 'shadow';
    const modeBadge = isShadow
      ? '<span class="mode-badge badge-shadow">SHADOW</span>'
      : '<span class="mode-badge badge-live">LIVE</span>';
    // Treat null AND 0 as 'no confidence reported': the bot pushes a separate
    // 'exit-*' resolution row with confidence omitted (stored as 0.0), and a
    // truly-zero model confidence on a placed trade is impossible by construction.
    // Renders '--' (matches the rest of the dashboard's missing-value glyph)
    // instead of a misleading '0%'.
    const confRaw = t.confidence;
    const hasConf = confRaw != null && Number(confRaw) > 0;
    const conf = hasConf ? Number(confRaw) : 0;
    const cCls = !hasConf ? 'text-dim' : conf >= 0.75 ? 'conf-hi' : conf >= 0.60 ? 'conf-mid' : 'conf-lo';
    const confDisp = hasConf ? `${Math.round(conf * 100)}%` : '--';
    // Strategy pill: every row carries one. CORE is the muted default,
    // EARLY (amber) and SCALP (violet) pop against it. Legacy rows with
    // null strategy_label collapse to CORE.
    const strat = t.strategy_label || 'expiry_convergence';
    let stratBadge = '';
    if (strat === 'early_entry') {
      stratBadge = '<span class="mode-badge badge-early" aria-label="early entry strategy">EARLY</span>';
    } else if (strat === 'scalp_exit') {
      stratBadge = '<span class="mode-badge badge-scalp" aria-label="scalp exit strategy">SCALP</span>';
    } else {
      stratBadge = '<span class="mode-badge badge-core" aria-label="core (expiry convergence) strategy">CORE</span>';
    }
    // Exit-trigger annotation under PNL value, scalp_exit only. Compact
    // mapping so the cell stays narrow; unknown values display upper-cased
    // (truncated) so a new bot-side trigger never breaks the layout.
    let trigLine = '';
    if (strat === 'scalp_exit' && t.exit_trigger) {
      const trigMap = { take_profit: 'TP', stop_loss: 'SL', time_exit: 'TIME', resolution: 'RES' };
      const k = String(t.exit_trigger).toLowerCase();
      const trigTxt = trigMap[k] || k.toUpperCase().slice(0, 6);
      trigLine = `<span class="exit-trig" aria-label="exit trigger ${k}">${trigTxt}</span>`;
    }
    const tr = document.createElement('tr');
    tr.dataset.tradeId = t.trade_id;
    tr.innerHTML = `
      <td class="text-dim">${fmtLocalTime(t.timestamp)}</td>
      <td>${t.asset || '--'} ${modeBadge}${stratBadge}</td>
      <td class="text-dim">${tf}</td>
      <td class="${dcls}">${dir}</td>
      <td class="td-num">$${Number(t.entry_price || 0).toFixed(3)}</td>
      <td class="td-num">$${Number(t.size_usd || 0).toFixed(2)}</td>
      <td class="td-num ${cCls}">${confDisp}</td>
      <td class="text-dim">${t.status || '--'}</td>
      <td class="${ocls}">${outcome}</td>
      <td class="td-num ${pnlCls}">${fmtUsd(pnl)}${trigLine}</td>`;
    tr.addEventListener('click', () => openTradeModal(t));
    body.appendChild(tr);
  });
  // Sort indicators
  $$('#tradesTable th.sortable').forEach(th => {
    th.classList.remove('sort-asc','sort-desc');
    if (th.dataset.sort === col) th.classList.add(desc ? 'sort-desc' : 'sort-asc');
  });
}

function bindTradesUI() {
  ['flAsset','flDir','flOutcome','flMode','flStrategy','flConf'].forEach(id => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => {
      const key = { flAsset:'asset', flDir:'dir', flOutcome:'outcome', flMode:'mode', flStrategy:'strategy', flConf:'conf' }[id];
      _tradesFilter[key] = el.value;
      renderTrades();
    });
  });
  $$('#tradesTable th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (_tradesSort.col === col) _tradesSort.desc = !_tradesSort.desc;
      else { _tradesSort.col = col; _tradesSort.desc = true; }
      renderTrades();
    });
  });
  const lm = $('tradesLoadMore');
  if (lm) lm.addEventListener('click', async () => {
    _tradesLimit += 50;
    await loadTrades();
  });
  const tgl = $('tradesToggle');
  if (tgl) tgl.addEventListener('click', () => {
    const body = $('tradesBody'), chv = $('tradesChevron');
    body?.classList.toggle('collapsed');
    chv?.classList.toggle('collapsed');
  });
  // Hourly sort toggle
  $('hourSortHour')?.addEventListener('click', () => { _hourlySort = 'hour'; toggleSortActive('hour'); loadHourly(); });
  $('hourSortWr')?.addEventListener('click', () => { _hourlySort = 'wr'; toggleSortActive('wr'); loadHourly(); });
}
function toggleSortActive(which) {
  $('hourSortHour')?.classList.toggle('active', which === 'hour');
  $('hourSortWr')?.classList.toggle('active', which === 'wr');
}

// ─── Trade drill-down modal ──────────────────────────────
function openTradeModal(t) {
  const modal = $('tradeModal');
  const body  = $('tradeBody');
  const title = $('tradeModalTitle');
  const sub   = $('tradeModalSub');
  if (!modal || !body) return;

  const pnl = Number(t.pnl || 0);
  const outcome = t.outcome || 'PENDING';
  const isShadow = t.shadow === true || String(t.mode || '').toLowerCase() === 'shadow';

  title.textContent = `TRADE · ${t.asset || '--'} ${t.direction || ''}`;
  sub.textContent = `${fmtLocalTime(t.timestamp)} · ${isShadow ? 'SHADOW' : 'LIVE'} · id ${t.trade_id || '--'}`;

  const rows = [
    ['Status',      t.status || '--'],
    ['Outcome',     outcome],
    ['Direction',   t.direction || '--'],
    ['Timeframe',   t.timeframe || '5m'],
    ['Entry price', `$${Number(t.entry_price || 0).toFixed(3)}`],
    ['Size',        `$${Number(t.size_usd || 0).toFixed(2)} (${Number(t.shares || 0).toFixed(2)} shares)`],
    ['Confidence',  `${Math.round(Number(t.confidence || 0) * 100)}%`],
    ['P&L',         fmtUsd(pnl)],
    ['Resolved at', t.resolved_at ? new Date(t.resolved_at).toLocaleString() : '—'],
    ['End time',    t.end_time ? new Date(t.end_time).toLocaleString() : '—'],
    ['Mode',        t.mode || (isShadow ? 'shadow' : 'live')],
  ];
  const dl = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  body.innerHTML = `
    <dl>${dl}</dl>
    <div class="needs-mainbot">
      Full context (book state at signal, fair_prob, edge, σ, gate passes,
      actual fill price, slippage in cents, strategy reasoning) is
      <strong>NEEDS-MAIN-BOT</strong>: trades table has only the columns
      shown above. Enrichment requires the bot to push these fields in
      the <code>trade</code> upsert payload.
    </div>
  `;
  modal.style.display = 'flex';
  audit(`open trade · ${t.trade_id || ''}`);
}
function bindTradeModal() {
  const modal = $('tradeModal');
  if (!modal) return;
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
  $('tradeClose')?.addEventListener('click', () => { modal.style.display = 'none'; });
}

// ─── Sparklines ──────────────────────────────────────────
function drawSpark(svg, values, opts = {}) {
  if (!svg) return;
  svg.innerHTML = '';
  if (!values.length) return;
  const W = opts.W || 600, H = opts.H || 120, PAD = opts.PAD || 6;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = (max - min) || 1;
  const x = (i) => PAD + (i / Math.max(1, values.length - 1)) * (W - PAD*2);
  const y = (v) => H - PAD - ((v - min) / range) * (H - PAD*2);
  const zeroY = y(0);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.insertAdjacentHTML('beforeend',
    `<line x1="${PAD}" x2="${W-PAD}" y1="${zeroY}" y2="${zeroY}" stroke="rgba(78,148,108,0.14)" stroke-dasharray="3 4"/>`);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];
  const color = last >= 0 ? '#5cb87a' : '#c44455';
  const dim   = last >= 0 ? '#3b7a54' : '#8a3040';
  const gradId = opts.gradId || `g${Math.random().toString(16).slice(2)}`;
  svg.insertAdjacentHTML('beforeend', `
    <defs>
      <linearGradient id="${gradId}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${dim}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${dim}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${path} L ${x(values.length-1)} ${zeroY} L ${x(0)} ${zeroY} Z" fill="url(#${gradId})"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${x(values.length-1)}" cy="${y(last)}" r="2.6" fill="${color}"/>
  `);
}
async function loadPnlChart() {
  const raw = await api('/api/pnl_series?limit=500&bot_type=bachelier');
  const cutoff = rangeStartMs();
  const vals = raw.filter(d => new Date(d.ts).getTime() >= cutoff).map(d => d.cum_pnl);
  // If range has too few points, fall back to full series so the chart isn't blank.
  const values = vals.length >= 2 ? vals : raw.map(d => d.cum_pnl);
  drawSpark($('pnlSpark'), values, { W: 600, H: 160, gradId: 'pnlGrad' });
  // Hero spark: same data but today-only, step cumulative
  const todayVals = raw.filter(d => new Date(d.ts).getTime() >= (new Date().setHours(0,0,0,0))).map(d => d.cum_pnl);
  drawSpark($('heroSpark'), todayVals.length >= 2 ? todayVals : [0, 0], { W: 320, H: 90, gradId: 'heroGrad' });
}

// ─── Slippage trend (placeholder — NEEDS-MAIN-BOT) ────────
function renderSlippage() {
  // Without book_ask_at_signal column we can't compute. Draw an empty state.
  const svg = $('slipSpark');
  if (!svg) return;
  svg.innerHTML = '';
  svg.insertAdjacentHTML('beforeend', `
    <line x1="6" x2="594" y1="60" y2="60" stroke="rgba(108,212,152,0.25)" stroke-dasharray="4 4"/>
    <text x="300" y="64" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10"
          fill="rgba(153,180,168,0.7)">data not yet in /api/trades schema</text>
  `);
}

// ─── Claude personality ──────────────────────────────────
function renderClaudeFace(state, running) {
  const face = $('claudeFace');
  const st   = $('claudeStatus');
  if (!face || !st) return;
  if (state === 'LIVE' || state === 'SHADOW') {
    face.classList.add('thinking');
    st.className = 'claude-status busy';
    st.textContent = running ? 'evaluating…' : 'idle';
  } else {
    face.classList.remove('thinking');
    st.className = 'claude-status';
    st.textContent = state === 'OFFLINE' ? 'offline' : 'unknown';
  }
}
function claudeSetStatus(s) {
  const st = $('claudeStatus');
  if (!st) return;
  // subtle pulse on data load
  st.classList.add('ok');
  setTimeout(() => st.classList.remove('ok'), 400);
}
function claudeBlink() {
  const face = $('claudeFace');
  if (!face) return;
  face.style.transform = 'scale(0.9)';
  setTimeout(() => { face.style.transform = ''; }, 180);
}

function renderClaudeConsole() {
  const el = $('claudeConsole');
  if (!el) return;
  const trades = (_trades || []).slice(0, 6);
  if (!trades.length) {
    el.innerHTML = '<span class="ccl-dim">// no trades synthesised yet</span>';
    return;
  }
  const lines = [];
  lines.push(`<span class="ccl-dim">// EXPERT console — synthesised from last ${trades.length} trades</span>`);
  trades.forEach(t => {
    const o = t.outcome || 'PENDING';
    const cls = o === 'WIN' ? 'ccl-hl' : o === 'LOSS' ? 'ccl-bad' : 'ccl-warn';
    const c = Math.round(Number(t.confidence || 0) * 100);
    const shadow = (t.shadow === true || String(t.mode || '').toLowerCase() === 'shadow') ? 'shadow' : 'live';
    lines.push(`<span class="ccl-dim">></span> ${t.asset || '?'} ${t.direction || '?'} @ $${Number(t.entry_price || 0).toFixed(3)} c=${c}% (${shadow}) → <span class="${cls}">${o}</span> ${fmtUsd(Number(t.pnl || 0))}`);
  });
  lines.push(`<span class="ccl-dim">// (trade context limited — see NEEDS-MAIN-BOT in docs/dashboard_work_20260423.md)</span>`);
  el.innerHTML = lines.join('\n');
}

// ─── Bot Avatar (preserved from prior app.js) ────────────
const bot = {
  stage: null, avatar: null, speech: null, arrows: null, notebook: null,
  mood: null, winCount: 0, lossCount: 0,
  lastResolvedId: null, firstLoad: true,
  speechTimer: null, stateTimer: null, nbTimer: null, ambientTimer: null,
  recentTrades: [],
};
function initBot() {
  bot.stage = $('botStage'); bot.avatar = $('botAvatar'); bot.speech = $('botSpeech');
  bot.arrows = $('botArrows'); bot.notebook = $('botNotebook'); bot.mood = $('botMood');
  if (!bot.stage) return;
  bot.stage.addEventListener('click', () => botAngry());
}
function botSetMood(l, c) { if (bot.mood) { bot.mood.textContent = l; bot.mood.className = c || 'text-green'; } }
function botSay(text, variant) {
  if (!bot.speech) return;
  bot.speech.className = 'bot-speech show' + (variant ? ' ' + variant : '');
  bot.speech.textContent = text;
  clearTimeout(bot.speechTimer);
  bot.speechTimer = setTimeout(() => { bot.speech.className = 'bot-speech'; }, 2600);
}
function botClearState(d) {
  clearTimeout(bot.stateTimer);
  bot.stateTimer = setTimeout(() => {
    if (bot.avatar) bot.avatar.classList.remove('happy','sad','angry');
    botSetMood('patrolling', 'text-green');
  }, d || 1600);
}
function botWin() {
  if (!bot.avatar) return;
  bot.avatar.classList.remove('sad','angry'); bot.avatar.classList.add('happy');
  botSetMood('celebrating','text-green'); botSay('CASHED IN!','');
  fireArrows(6); bot.winCount++; if ($('botWinCount')) $('botWinCount').textContent = bot.winCount;
  botClearState(1800);
}
function botLoss() {
  if (!bot.avatar) return;
  bot.avatar.classList.remove('happy','angry'); bot.avatar.classList.add('sad');
  botSetMood('taking notes','text-amber'); botSay('NOTED.','warn');
  showNotebook(); bot.lossCount++; if ($('botLossCount')) $('botLossCount').textContent = bot.lossCount;
  botClearState(2200);
}
function botAngry() {
  if (!bot.avatar) return;
  bot.avatar.classList.remove('happy','sad'); bot.avatar.classList.add('angry');
  const lines = ['HEY!','STOP POKING!','RUDE.','I AM WORKING.','LEAVE ME ALONE!'];
  botSay(lines[Math.floor(Math.random()*lines.length)],'bad');
  botSetMood('annoyed','text-red'); botClearState(1400);
}
function fireArrows(n) {
  if (!bot.arrows) return;
  bot.arrows.innerHTML = '';
  for (let i=0; i<n; i++) {
    const a = document.createElement('div'); a.className = 'bot-arrow';
    const angle = -20 - Math.random()*50; const dist = 160 + Math.random()*120;
    a.style.setProperty('--ang', angle+'deg');
    a.style.setProperty('--dx', (Math.cos(angle*Math.PI/180)*dist).toFixed(0)+'px');
    a.style.setProperty('--dy', (Math.sin(angle*Math.PI/180)*dist).toFixed(0)+'px');
    a.style.animationDelay = (i*0.07).toFixed(2)+'s';
    bot.arrows.appendChild(a);
  }
  setTimeout(() => { if (bot.arrows) bot.arrows.innerHTML = ''; }, 1800);
}
function showNotebook() {
  if (!bot.notebook) return;
  bot.notebook.classList.add('show');
  clearTimeout(bot.nbTimer);
  bot.nbTimer = setTimeout(() => { bot.notebook?.classList.remove('show'); }, 2400);
}
function botReactToTrades(trades) {
  bot.recentTrades = trades.slice(0, 20);
  const latest = trades.find(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  if (!latest) return;
  const id = latest.trade_id;
  if (bot.firstLoad) { bot.lastResolvedId = id; bot.firstLoad = false; return; }
  if (id === bot.lastResolvedId) return;
  bot.lastResolvedId = id;
  if (latest.outcome === 'WIN') botWin(); else if (latest.outcome === 'LOSS') botLoss();
}
const PHRASES = {
  neutral: ["Coffee first. Trades second.","Scanning 5m candles…","Waiting for that juicy edge.","Books look thin. Patient.","Markets chill. I'm chill.","Running diagnostics. All green.","Eyes peeled. Fingers ready."],
  hot:     ["Damn, we're RAMPING up!","This streak is unreal.","Edge is printing money.","Feels illegal to be this good."],
  cold:    ["Today's a slow one…","Market's being rude.","Patience mode: activated.","We'll get 'em next cycle."],
  paper:   ["Still on paper. Learning.","Building the brain…","n < 500. Grinding.","Paper mode, big dreams."],
};
function pickPhraseBucket() {
  const resolved = (bot.recentTrades || []).filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  if (resolved.length < 3) return (window.__lastSummary?.status?.shadow_mode) ? 'paper' : 'neutral';
  const r10 = resolved.slice(0, 10);
  const rate = r10.filter(t => t.outcome === 'WIN').length / r10.length;
  const pnl = r10.reduce((s,t) => s + (Number(t.pnl) || 0), 0);
  if (rate >= 0.7 || pnl >= 25) return 'hot';
  if (rate <= 0.35 || pnl <= -10) return 'cold';
  return 'neutral';
}
function botAmbient() {
  if (!bot.speech) return;
  if (bot.speech.classList.contains('show')) return;
  const pool = PHRASES[pickPhraseBucket()] || PHRASES.neutral;
  bot.speech.className = 'bot-speech show';
  bot.speech.textContent = pool[Math.floor(Math.random()*pool.length)];
  clearTimeout(bot.ambientTimer);
  bot.ambientTimer = setTimeout(() => { if (bot.speech) bot.speech.className = 'bot-speech'; }, 4500);
}

// ─── Controls (Start / Pause / Emergency Stop) ────────────
async function sendControl(cmd) {
  const el = $('ctrlStatus');
  if (el) { el.className = 'ctrl-status'; el.textContent = 'sending…'; }
  audit(`control · ${cmd}`);
  try {
    const r = await fetch('/api/bot/control', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    if (!r.ok) {
      let msg = 'FAILED';
      try { const j = await r.json(); msg = (j.detail || '').slice(0,60) || msg; } catch {}
      throw new Error(msg);
    }
    const j = await r.json();
    applyControlState(j.command || cmd);
    botSay(cmd === 'pause' ? 'taking a break.' : "let's go!", cmd === 'pause' ? 'warn' : '');
  } catch (e) {
    if (el) { el.className = 'ctrl-status err'; el.textContent = String(e.message || 'FAILED'); }
    audit(`control FAILED · ${cmd} · ${e.message || e}`);
  }
}
function applyControlState(cmd) {
  const pb = $('pauseBtn'), sb = $('startBtn');
  const el = $('ctrlStatus');
  const paused = (cmd === 'pause');
  if (sb) sb.classList.toggle('active', !paused);
  if (pb) pb.classList.toggle('active', paused);
  if (el) { el.className = 'ctrl-status ' + (paused ? 'warn' : 'ok'); el.textContent = paused ? 'PAUSED' : 'RUNNING'; }
  // Mirror to mobile buttons
  ['startBtnMobile','pauseBtnMobile'].forEach(id => {
    const x = $(id); if (!x) return;
    const isPause = id === 'pauseBtnMobile';
    x.classList.toggle('active', isPause === paused);
  });
}

// ─── Generic typed-confirm modal (shared by EXPERT actions) ─
function confirmAction({ title, body, onConfirm }) {
  const modal = $('confirmModal');
  if (!modal) return;
  $('confirmTitle').textContent = title;
  $('confirmBody').innerHTML = body;
  const inp = $('confirmInput');
  inp.value = ''; inp.placeholder = 'type CONFIRM';
  const go = $('confirmGo');
  go.disabled = true;
  $('confirmErr').textContent = '';
  modal.style.display = 'flex';
  setTimeout(() => inp.focus(), 50);

  const onType = () => { go.disabled = inp.value.trim().toUpperCase() !== 'CONFIRM'; };
  inp.oninput = onType;
  $('confirmCancel').onclick = () => { modal.style.display = 'none'; };
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
  go.onclick = async () => {
    go.disabled = true;
    try { await onConfirm(); modal.style.display = 'none'; }
    catch (e) { $('confirmErr').textContent = String(e.message || e); go.disabled = false; }
  };
}

// ─── Emergency Stop (used by 2 triggers: card button + sticky) ─
function estopOpen() {
  const modal = $('estopModal'), inp = $('estopConfirm'), go = $('estopGo'), err = $('estopErr');
  if (!modal) return;
  inp.value = ''; go.disabled = true; err.textContent = '';
  modal.style.display = 'flex';
  setTimeout(() => inp.focus(), 50);
}
function bindEstop() {
  const modal = $('estopModal'), inp = $('estopConfirm'), go = $('estopGo'),
        cancel = $('estopCancel'), err = $('estopErr');
  if (!modal) return;
  const close = () => { modal.style.display = 'none'; inp.value = ''; go.disabled = true; err.textContent = ''; };
  $('estopOpenBtn')?.addEventListener('click', estopOpen);
  $('stickyEstop')?.addEventListener('click', estopOpen);
  cancel?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  inp?.addEventListener('input', () => { go.disabled = inp.value.trim().toUpperCase() !== 'STOP'; });
  go?.addEventListener('click', async () => {
    go.disabled = true; err.textContent = '';
    try {
      const r = await fetch('/api/bot/control', {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ command: 'pause' }),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const j = await r.json(); if (j.detail) msg = j.detail; } catch {}
        throw new Error(msg);
      }
      applyControlState('pause'); close();
      audit('EMERGENCY STOP confirmed');
      botSay('STOPPED.','bad');
    } catch (e) { err.textContent = `failed: ${e.message || e}`; go.disabled = false; audit(`ESTOP failed · ${e.message || e}`); }
  });
}

// ─── Controls bindings (called on init + mode change) ────
function bindControls() {
  const ids = ['startBtn','pauseBtn','startBtnMobile','pauseBtnMobile'];
  ids.forEach(id => {
    const el = $(id);
    if (!el || el.dataset.bound === '1') return;
    const cmd = id.toLowerCase().includes('pause') ? 'pause' : 'start';
    el.addEventListener('click', () => sendControl(cmd));
    el.dataset.bound = '1';
  });
}

// ─── Cap-override slider (PILOT, UI-only — NEEDS-MAIN-BOT) ─
function bindCapSlider() {
  const sl = $('capSlider'), out = $('capSliderVal');
  if (!sl || !out) return;
  const stored = Number(localStorage.getItem('polybot_cap_override') || 0);
  if (stored > 0) { sl.value = stored; out.textContent = `$${stored}`; }
  sl.addEventListener('input', () => { out.textContent = `$${sl.value}`; });
  sl.addEventListener('change', () => {
    confirmAction({
      title: 'DAILY CAP OVERRIDE',
      body: `Set cap to $${sl.value} at next UTC midnight? This is a client-side hold; the bot does not yet accept runtime cap overrides (NEEDS-MAIN-BOT).`,
      onConfirm: () => {
        localStorage.setItem('polybot_cap_override', sl.value);
        audit(`cap override → $${sl.value}`);
      },
    });
  });
}

// ─── Combined top-bar / pane-headers (two-pane layout) ─────
// Pulls /api/combined_summary and updates: combined PnL hero, combined
// bankroll, combined kill state, live indicator, both panes' meta
// strips, and the bottom-bar rail pills.
async function loadCombined() {
  let data;
  try { data = await api('/api/combined_summary'); }
  catch (e) { if (e.message !== 'unauth') console.warn('combined err', e); return; }

  const c = data.combined || {};
  const copy = data.copy || {};
  const bach = data.bachelier || {};

  // Top bar — combined PnL (the headline).
  const pnl = Number(c.pnl_today || 0);
  const pnlEl = $('combinedPnl');
  if (pnlEl) {
    pnlEl.textContent = fmtUsd(pnl);
    pnlEl.className = 'combined-pnl ' + (pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'neutral');
  }
  // Combined bankroll: just sum of both bots' wallet readings, against $500
  // total target. Shows '$--' if neither bot has reported a wallet yet.
  const br = c.bankroll_usdc;
  const brEl = $('combinedBankroll');
  if (brEl) brEl.textContent = (br != null) ? `$${Number(br).toFixed(0)} / $500` : '$-- / $500';

  // Combined kill state — single dot in top-bar status pill.
  const kill = String(c.kill_state || 'green');
  const killDot = $('combinedKillDot');
  const killTxt = $('combinedKillTxt');
  if (killDot) killDot.className = 'status-dot' + (kill === 'green' ? '' : ' offline');
  if (killTxt) killTxt.textContent = kill === 'red' ? 'HALTED' : kill === 'amber' ? 'COOLING' : 'ARMED';

  // live: yes/no — amber pill until LIVE_AUTHORIZED true on every configured bot.
  const liveInd = $('liveIndicator');
  const liveSt = $('liveState');
  if (liveSt) liveSt.textContent = c.live_authorized ? 'yes' : 'no';
  if (liveInd) liveInd.classList.toggle('is-live', !!c.live_authorized);

  // Per-pane meta strips.
  _writePaneMeta('copy', copy);
  _writePaneMeta('bach', bach);

  // Toggle the copy pane's empty-state.
  const copyEmpty = $('copyEmpty');
  if (copyEmpty) copyEmpty.style.display = copy.configured ? 'none' : 'block';

  // Bottom-bar rail pills mirror the BACHELIER bot's killswitches list
  // (bachelier owns the rails today; copy bot doesn't surface them).
  const rails = (bach.killswitches && Array.isArray(bach.killswitches)) ? bach.killswitches : [];
  const byId = new Map();
  rails.forEach(h => byId.set(Number(h.rail_id), h));
  document.querySelectorAll('.bb-rail').forEach(el => {
    const id = Number(el.dataset.rail);
    const halt = byId.get(id);
    el.className = 'bb-rail ' + (halt ? (
      String(halt.action || '').toLowerCase().includes('cool') ? 'rail-cooling' : 'rail-fired'
    ) : 'rail-armed');
  });
}
function _writePaneMeta(prefix, b) {
  const cfg = !!b.configured;
  const wb = $(`${prefix}Bankroll`);
  const wpnl = $(`${prefix}PnlToday`);
  const wopen = $(`${prefix === 'copy' ? 'copy' : 'bach'}Open`);
  if (wb) wb.textContent = (b.wallet_usdc != null) ? `$${Number(b.wallet_usdc).toFixed(0)}` : '$--';
  if (wpnl) {
    const v = Number(b.pnl_today || 0);
    wpnl.textContent = fmtUsd(v);
    wpnl.className = 'meta-val ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  }
  if (wopen) wopen.textContent = cfg ? String(b.open_positions || 0) : '--';
}

// ─── Refresh loop ────────────────────────────────────────
async function refreshAll() {
  try {
    claudeSetStatus('loading');
    await loadSummary();
    await Promise.all([
      loadCombined(),
      loadAssets(),
      loadTimeframes(),
      loadHourly(),
      loadTrades(),
      loadPnlChart(),
      loadLiveVsShadow(),
      loadStrategyCompare(),
    ]);
    renderSlippage();
    if (document.body.classList.contains('mode-expert')) renderClaudeConsole();
  } catch (e) {
    if (e.message !== 'unauth') console.warn('refresh err', e);
  }
}

// ─── Mobile sheet ─────────────────────────────────────────
function bindMobileSheet() {
  const btn = $('mobileMenuBtn');
  const sheet = $('mobileSheet');
  const close = $('mobileSheetClose');
  if (!btn || !sheet) return;
  btn.addEventListener('click', () => { sheet.style.display = 'flex'; });
  close?.addEventListener('click', () => { sheet.style.display = 'none'; });
  $('logoutBtnMobile')?.addEventListener('click', doLogout);
}

// ─── Init ────────────────────────────────────────────────
initBot();
applyMode();
setRange(getRange());
bindControls();
bindEstop();
bindTradesUI();
bindTradeModal();
bindCapSlider();
bindMobileSheet();

$('logoutBtn')?.addEventListener('click', doLogout);
MODES.forEach(m => {
  $(`mode${m[0].toUpperCase()+m.slice(1)}Btn`)?.addEventListener('click', () => setMode(m));
});
$('timeRangeSel')?.addEventListener('change', (e) => setRange(e.target.value));
$('refreshBtn')?.addEventListener('click', () => { audit('manual refresh'); refreshAll(); });
$('railsToggleBtn')?.addEventListener('click', () => toggleRailsDetail());
// Brier tooltip popover
$('brier') && (()=>{}); // legacy id may not exist anymore; tooltip attribute does the work

loadMe().then(() => {
  refreshAll();
  setInterval(refreshAll, POLL_INTERVAL_MS);
});

setTimeout(botAmbient, 3000);
setInterval(botAmbient, 10000);

// Initial audit line
audit('session start');
