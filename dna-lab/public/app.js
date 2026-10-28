'use strict';
/* Market DNA V1 — panel istemcisi. Yalnızca gerçek sistem durumu ve sonuçları gösterir. */
(() => {
  const $ = (id) => document.getElementById(id);
  /**
   * API tabanı — ayrık barındırma desteği (örn. panel Vercel statik, backend Railway/Fly).
   * Öncelik: ?api=https://... URL parametresi (kalıcı localStorage'a yazılır) → localStorage.dnaApiBase → aynı origin.
   */
  const API_BASE = (() => {
    const q = new URLSearchParams(location.search).get('api');
    if (q) { try { localStorage.setItem('dnaApiBase', q.replace(/\/+$/, '')); } catch (_) {} }
    try { return (q || localStorage.getItem('dnaApiBase') || '').replace(/\/+$/, ''); } catch (_) { return (q || '').replace(/\/+$/, ''); }
  })();
  const state = {
    view: 'market',
    last: null,       // son /api/state snapshot
    events: [],       // canlı DNA olayları
    episodes: [],     // son episod olayları
    motifs: [],       // learner snapshot
    evalLog: [],
    selectedCoin: null,
    background: null,
    es: null,
  };

  const fmt = {
    price(v) { return v == null ? '—' : Number(v).toLocaleString('tr-TR', { maximumFractionDigits: Number(v) < 10 ? 6 : 2 }); },
    compact(v) { if (v == null) return '—'; const a = Math.abs(v); if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return String(Math.round(v)); },
    clock(ts) { return ts ? new Date(ts).toLocaleTimeString('tr-TR', { hour12: false }) : '—'; },
  };

  function evClass(ev) {
    if (ev.startsWith('WALL')) return 'wall';
    if (ev.startsWith('FLOW')) return 'flow';
    if (ev === 'BOOK_TILT' || ev === 'MICRO_FLIP' || ev === 'VOID_OPEN') return 'book';
    if (ev === 'SWEEP_REJECT') return 'price';
    return 'sys';
  }

  /* ---------------- sekmeler ---------------- */
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => { b.classList.toggle('active', b === btn); b.setAttribute('aria-selected', b === btn); });
      state.view = btn.dataset.tab;
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== state.view));
      render();
    });
  });

  /* ---------------- SSE ---------------- */
  function connectSSE() {
    if (state.es) state.es.close();
    const es = new EventSource(API_BASE + '/api/stream');
    state.es = es;
    es.addEventListener('state', (e) => { const m = JSON.parse(e.data); state.last = m.data; render(); });
    es.addEventListener('dnaEvent', (e) => {
      const m = JSON.parse(e.data);
      state.events.unshift(m.data);
      if (state.events.length > 60) state.events.pop();
      if (m.data.event === 'WALL_SPAWN' || m.data.event === 'WALL_PULL' || m.data.event === 'WALL_BREAK') renderWalls();
      renderChain();
    });
    es.addEventListener('episode', (e) => { const m = JSON.parse(e.data); state.episodes.unshift({ ...m.data, resolved: false }); trimEpisodes(); renderEpisodes(); });
    es.addEventListener('episodeResolved', (e) => { const m = JSON.parse(e.data); state.episodes.unshift({ ...m.data, resolved: true }); trimEpisodes(); renderEpisodes(); });
    es.addEventListener('motif', (e) => { const m = JSON.parse(e.data); upsertMotif(m.data); renderMotifs(); });
    es.addEventListener('discovery', (e) => {
      const m = JSON.parse(e.data);
      state.evalLog.unshift({ ts: Date.now(), line: `DISCOVERY: ${m.data.key} (pencere: ${m.data.windowCount})`, cls: 'fail' });
      renderEvalLog();
    });
    es.addEventListener('invalidation', (e) => {
      const m = JSON.parse(e.data);
      state.evalLog.unshift({ ts: m.data.at, line: `YAPISAL GEÇERSİZLİK: ${m.data.epId} ← ${m.data.by}`, cls: 'fail' });
      renderEvalLog();
    });
    es.addEventListener('log', (e) => {
      const m = JSON.parse(e.data);
      if (/MEZUNİYET|KARANTINA/.test(m.data.line)) {
        state.evalLog.unshift({ ts: m.data.ts, line: m.data.line, cls: /MEZUNİYET/.test(m.data.line) ? 'pass' : 'fail' });
        if (state.evalLog.length > 40) state.evalLog.pop();
        renderEvalLog();
      }
    });
    es.onerror = () => { /* EventSource otomatik yeniden bağlanır */ };
  }
  function trimEpisodes() { if (state.episodes.length > 30) state.episodes.pop(); }
  function upsertMotif(m) {
    const i = state.motifs.findIndex((x) => x.motifId === m.motifId);
    if (i >= 0) state.motifs[i] = m; else state.motifs.push(m);
  }

  /* ---------------- coin seçimi ---------------- */
  async function loadCoins() {
    try {
      const r = await fetch(API_BASE + '/api/coins');
      const j = await r.json();
      const wrap = $('coinChoices');
      wrap.innerHTML = '';
      for (const c of j.coins) {
        const b = document.createElement('button');
        b.className = 'coin-choice' + (state.selectedCoin === c ? ' active' : '');
        b.textContent = c;
        b.addEventListener('click', () => selectCoin(c));
        wrap.appendChild(b);
      }
    } catch (_) {}
  }
  async function selectCoin(sym) {
    sym = (sym || '').toUpperCase().trim();
    if (!sym) return;
    try {
      const r = await fetch(API_BASE + '/api/coin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym }) });
      const j = await r.json();
      if (j.error) return alert('Hata: ' + j.error);
      state.selectedCoin = sym;
      state.events = []; state.episodes = []; state.motifs = [];
      loadCoins();
      render();
    } catch (e) { alert('Coin seçilemedi: ' + e.message); }
  }
  $('customCoinBtn').addEventListener('click', () => { const v = $('customCoin').value; if (v) selectCoin(v); });
  $('customCoin').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = $('customCoin').value; if (v) selectCoin(v); } });
  $('coinBtn').addEventListener('click', () => { switchView('settings'); });
  function switchView(name) {
    document.querySelector(`.nav-item[data-tab="${name}"]`).click();
  }

  /* ---------------- arka plan kuluçka ---------------- */
  $('bgToggle').addEventListener('click', async () => {
    const next = !(state.background === true);
    try {
      await fetch(API_BASE + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ background: next }) });
      state.background = next;
      renderSettings();
    } catch (_) {}
  });
  $('endSessionBtn').addEventListener('click', async () => {
    try {
      await fetch(API_BASE + '/api/session/end', { method: 'POST' });
    } catch (_) {}
  });

  /* ---------------- render ---------------- */
  function render() {
    const s = state.last;
    if (!s) return;
    // üst durum
    const st = $('engineState');
    const label = s.statusLabel || 'BEKLEMEDE';
    $('engineStateLabel').textContent = label;
    const statusKind = label === 'MEZUN MOTİF AKTİF' ? 'running'
      : (label === 'VERİ KOPUK' || label === 'YAPISAL GEÇERSİZLİK') ? 'gap'
      : (s.phase === 'running') ? 'running' : 'paused';
    st.dataset.status = statusKind;
    $('phaseChip').textContent = `${s.phase} · istemci:${s.clients}`;

    if (s.session && s.session.symbol) {
      $('coinName').textContent = s.session.symbol;
      $('coinBadge').textContent = s.session.symbol.slice(0, 3);
      $('coinSub').textContent = s.session.startedAt ? ('oturum: ' + fmt.clock(s.session.startedAt) + (s.session.sessionGaps ? ` · ${s.session.sessionGaps} oturum boşluğu` : '')) : 'oturum açılıyor…';
    } else {
      $('coinName').textContent = 'COİN SEÇ';
      $('coinBadge').textContent = '—';
      $('coinSub').textContent = 'analiz için coin seçin';
    }

    renderVenues(s);
    renderPrice(s);
    renderDna(s);
    renderMotifs();
    renderBase();
    renderMemory(s);
    renderSettings();
    renderChain();
    renderEpisodes();
  }

  function renderVenues(s) {
    const grid = $('venueGrid');
    if (!s.venues || !s.venues.length) { grid.innerHTML = '<div class="venue-empty">Kaynak bağlantıları coin seçilince başlar.</div>'; return; }
    grid.innerHTML = '';
    for (const v of s.venues) {
      for (const ep of v.endpoints) {
        const row = document.createElement('div');
        row.className = 'venue-row';
        const stCls = (ep.state || 'idle').toLowerCase();
        row.innerHTML = `
          <span class="venue-name">${escapeHtml(v.venue)} <span class="venue-meta">${escapeHtml(ep.name)}</span></span>
          <span class="venue-meta">msg:${fmt.compact(ep.msgCount)} · rec:${ep.reconnects} · sessiz:${ep.silentMs == null ? '—' : (ep.silentMs / 1000).toFixed(0) + 's'}</span>
          <span class="venue-state ${stCls}">${ep.state.toUpperCase()}</span>`;
        grid.appendChild(row);
      }
    }
  }

  function renderPrice(s) {
    if (!s.engine || !s.engine.encoder) return;
    let last = null, spread = null, lag = null;
    for (const v of s.engine.encoder.venues) {
      if (v.venue === 'binance_futures') { last = v.book.mid; spread = v.book.spreadBps; }
      if (lag === null && v.book) lag = null;
    }
    for (const v of s.venues || []) { if (v.lagMsEwma != null) { lag = v.lagMsEwma; break; } }
    // son işlem fiyatı: zincirdeki trade yoksa mid
    const tradeEv = state.events.find((e) => false);
    if (last == null) {
      for (const v of s.engine.encoder.venues) { if (v.book.mid) { last = v.book.mid; break; } }
    }
    $('lastPrice').textContent = fmt.price(last);
    $('spreadVal').textContent = spread == null ? '—' : spread.toFixed(2) + ' bps';
    $('lagVal').textContent = lag == null ? '—' : lag + ' ms';
  }

  function renderWalls() {
    const s = state.last;
    const wrap = $('wallList');
    if (!s || !s.engine || !s.engine.encoder) return;
    const walls = [];
    for (const v of s.engine.encoder.venues) for (const w of (v.walls || [])) walls.push({ venue: v.venue, ...w });
    if (!walls.length) { wrap.innerHTML = '<div class="empty-line">Aktif duvar yok (eşik: medyan × k, kanal top-20/400).</div>'; return; }
    wrap.innerHTML = '';
    for (const w of walls.slice(0, 8)) {
      const d = document.createElement('div');
      d.className = 'wall-item';
      d.innerHTML = `<span class="${w.side}">${w.side === 'bid' ? 'ALIŞ' : 'SATIŞ'} ${fmt.price(w.price)}</span>
        <span class="wall-meta">${fmt.compact(w.notional)} USDT · tepe ${fmt.compact(w.peakNotional)} · ${w.state}${w.tested ? ' · test' : ''}</span>
        <span class="wall-meta">${escapeHtml(w.venue.split('_')[0])}</span>`;
      wrap.appendChild(d);
    }
  }

  function renderDna(s) {
    const chip = $('dnaStatusChip');
    const sub = $('dnaStatusSub');
    const label = s.statusLabel || 'GÖZLEMDE';
    chip.textContent = label;
    const kind = label === 'MEZUN MOTİF AKTİF' ? 'grad' : (label === 'VERİ KOPUK' || label === 'YAPISAL GEÇERSİZLİK' || label === 'KARANTINA') ? 'bad' : (label === 'DOĞRULANIYOR' || label === 'KULUÇKADA') ? 'warn' : '';
    chip.dataset.kind = kind;
    if (s.session && s.session.symbol) {
      const motifs = (s.engine.motifs || []);
      sub.textContent = `${s.engine.encoder.stats.total} olay kodlandı · ${motifs.length} motif · ${s.engine.learnerResolvedPool} çözülmüş episod havuzu · ${s.engine.episodes.length} aktif oturum episodu`;
    } else sub.textContent = 'motor durumunu bekliyor';

    // sessizlik gerekçesi
    const sb = $('silenceBox');
    if (s.silenceReason) { sb.hidden = false; $('silenceText').textContent = s.silenceReason.text; } else sb.hidden = true;

    // tahmin kartı (yalnız mezun motif)
    const pb = $('predBox');
    if (s.activePrediction) {
      pb.hidden = false;
      const p = s.activePrediction;
      $('predMotif').textContent = `${p.motifKey} · ufuk ${p.horizonSec}s`;
      const g = $('predGrid');
      g.innerHTML = ['UP', 'FLAT', 'DOWN'].map((k) => `<div class="pred-cell ${k.toLowerCase()}"><b>${(p.probs[k] * 100).toFixed(1)}%</b><span>${k}</span></div>`).join('');
      const inv = $('predInvalidation');
      if (p.invalidation) { inv.classList.remove('ok'); inv.textContent = `YAPISAL GEÇERSİZLİK: ${p.invalidation.by} olayı tezi bozdu (${fmt.clock(p.invalidation.at)}).` + (p.invalidation.outcome ? ` İptal değerlendirmesi: ${JSON.stringify(p.invalidation.outcome)}` : ''); }
      else { inv.classList.add('ok'); inv.textContent = `Geçersizlik koşulu: mezun motifin öğrendiği bozucu olaylar aktif değil. FLAT bandı: ${p.bandBps} bps.`; }
    } else pb.hidden = true;
  }

  function renderChain() {
    const wrap = $('chainList');
    if (!state.events.length) { wrap.innerHTML = '<div class="empty-line">Olay bekleniyor…</div>'; return; }
    wrap.innerHTML = '';
    for (const ev of state.events.slice(0, 30)) {
      const d = document.createElement('div');
      d.className = 'chain-item';
      const side = ev.side ? `<span class="chain-side-${ev.side}">${ev.side}</span>` : '';
      d.innerHTML = `<span class="chain-ev ${evClass(ev.event)}">${escapeHtml(ev.event)}</span>
        <span class="chain-venue">${escapeHtml(ev.venue)} ${side}${ev.price ? ' · ' + fmt.price(ev.price) : ''}${ev.details && ev.details.note ? ' · ' + escapeHtml(ev.details.note) : ''}</span>
        <span class="chain-ts">${fmt.clock(ev.ts)}</span>`;
      wrap.appendChild(d);
    }
  }

  function renderEpisodes() {
    const wrap = $('epList');
    if (!state.episodes.length) { wrap.innerHTML = '<div class="empty-line">Epizod bekleniyor…</div>'; return; }
    wrap.innerHTML = '';
    for (const ep of state.episodes.slice(0, 12)) {
      const d = document.createElement('div');
      d.className = 'ep-item';
      const hz = Object.entries(ep.outcomes || {}).map(([H, o]) => `<span class="${o ? 'resolved-' + o.toLowerCase() : ''}">${H}s:${o || '⏳'}</span>`).join('');
      d.innerHTML = `<div class="ep-top"><span>${escapeHtml(ep.motifKey || '')}</span><span>${ep.resolved ? 'çözüldü' : 'bekliyor'} · ${fmt.clock(ep.t0 || Date.now())}</span></div>
        <div class="ep-chain">${escapeHtml(JSON.stringify(ep.chain))}</div>
        <div class="ep-hz">${hz}</div>`;
      wrap.appendChild(d);
    }
  }

  function renderMotifs() {
    const s = state.last;
    const wrap = $('motifList');
    const motifs = (s && s.engine && s.engine.motifs) || state.motifs;
    if (!motifs.length) { wrap.innerHTML = '<div class="empty-line">Motif yok — sistem gözlemde.</div>'; return; }
    wrap.innerHTML = '';
    for (const m of [...motifs].sort((a, b) => (a.state === 'GRADUATED' ? -1 : 1) - (b.state === 'GRADUATED' ? -1 : 1))) {
      const d = document.createElement('div');
      d.className = 'motif-item';
      const met = m.metrics;
      const inval = m.invalidators && Object.keys(m.invalidators).length
        ? `<div class="motif-inval">Yapısal geçersizlik öğrendi: ${Object.entries(m.invalidators).map(([k, v]) => `${k} (hata ${ (v.rWith*100).toFixed(0) }% → ${ (v.rWithout*100).toFixed(0) }%)`).join(', ')}</div>` : '';
      d.innerHTML = `
        <div class="motif-top"><span class="motif-chain">${escapeHtml(m.key)}</span><span class="motif-state" data-state="${m.state}">${m.state}</span></div>
        <div class="motif-meta">
          <span>episod: <b>${m.episodes ?? m.episodesTotal ?? 0}</b></span>
          ${met ? `<span>N_eff: <b>${met.nEff}</b> (küme ${met.nClusters} / seri ${met.nSerial})</span>
          <span>Brier: <b>${met.brierMotif?.toFixed(3)}</b> vs baz <b>${met.brierBase?.toFixed(3)}</b></span>
          <span>lift: <b>${met.lift?.toFixed(3)}</b> CI[${met.ciLow == null ? '—' : met.ciLow.toFixed(3)}, ${met.ciHigh == null ? '—' : met.ciHigh.toFixed(3)}]</span>
          <span>p: <b>${met.pValue == null ? '—' : met.pValue.toFixed(3)}</b> q: <b>${met.qValue == null ? '—' : met.qValue.toFixed(3)}</b></span>
          <span>ECE: <b>${met.ece == null ? '—' : met.ece.toFixed(3)}</b></span>
          <span>ufuk: <b>${met.horizonSec}s</b></span>` : ''}
          ${m.quarantineReason ? `<span class="motif-inval">karantina: ${escapeHtml(m.quarantineReason)}</span>` : ''}
        </div>${inval}`;
      wrap.appendChild(d);
    }
  }

  function renderBase() {
    const s = state.last;
    const g = $('baseGrid');
    const bm = s && s.engine && s.engine.baseModels;
    if (!bm) { g.innerHTML = '<div class="empty-line">Henüz skorlama verisi yok.</div>'; return; }
    const rows = Object.entries(bm).map(([name, v]) => ({ name, v }));
    const best = rows.filter((r) => r.v.meanBrier != null).sort((a, b) => a.v.meanBrier - b.v.meanBrier)[0];
    g.innerHTML = '';
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'base-row';
      d.innerHTML = `<span>${r.name}</span><span class="venue-meta">n:${r.v.n}</span><b class="${best && best.name === r.name ? 'base-best' : ''}">${r.v.meanBrier == null ? '—' : r.v.meanBrier.toFixed(4)}</b>`;
      g.appendChild(d);
    }
  }

  async function renderMemory(s) {
    const grid = $('memGrid');
    const sym = s && s.session && s.session.symbol;
    $('memoryTitle').textContent = sym ? `${sym} kalıcı hafıza` : 'Kalıcı öğrenme';
    if (!sym) { grid.innerHTML = '<div class="empty-line">Oturum açılınca hafıza durumu görünür.</div>'; $('memFiles').innerHTML = ''; return; }
    try {
      const r = await fetch(API_BASE + '/api/memory/' + sym);
      const j = await r.json();
      const st = j.state || {};
      const c = st.counters || {};
      grid.innerHTML = `
        <div class="mem-cell"><b>${j.schemaVersion}</b><span>ŞEMA SÜRÜMÜ</span></div>
        <div class="mem-cell"><b>${st.sessions ?? 0}</b><span>OTURUM</span></div>
        <div class="mem-cell"><b>${fmt.compact(c.eventsTotal)}</b><span>KAYITLI OLAY</span></div>
        <div class="mem-cell"><b>${fmt.compact(c.episodesTotal)}</b><span>EPIZOD</span></div>
        <div class="mem-cell"><b>${st.lastSessionEnd ? fmt.clock(st.lastSessionEnd) : '—'}</b><span>SON OTURUM SONU</span></div>
        <div class="mem-cell"><b>${(st.motifs || 0)}</b><span>KAYITLI MOTİF</span></div>
        <div class="mem-cell"><b>${st.updatedAt ? fmt.clock(st.updatedAt) : '—'}</b><span>SON YAZIM</span></div>
        <div class="mem-cell"><b>${j.recovered ? 'KURTARMA' : 'OK'}</b><span>YÜKLEME DURUMU</span></div>`;
      $('memFiles').innerHTML = (j.files || []).map((f) => `<span>${escapeHtml(f.name)} · ${fmt.compact(f.size)}B</span>`).join('');
    } catch (_) {}
  }

  function renderEvalLog() {
    const wrap = $('evalLog');
    if (!state.evalLog.length) { wrap.innerHTML = '<div class="empty-line">Değerlendirme kaydı yok.</div>'; return; }
    wrap.innerHTML = state.evalLog.slice(0, 20).map((l) => `<span class="${l.cls || ''}">[${fmt.clock(l.ts)}] ${escapeHtml(l.line)}</span>`).join('');
  }

  function renderSettings() {
    const s = state.last;
    const bg = s ? s.background : null;
    if (bg !== null && bg !== undefined) state.background = bg;
    $('bgToggle').setAttribute('aria-pressed', String(state.background === true));
    $('bgLabel').textContent = state.background ? 'AÇIK' : 'KAPALI';
    const src = $('srcList');
    if (s && s.venues && s.venues.length) {
      src.innerHTML = s.venues.map((v) => v.endpoints.map((ep) => `<div class="venue-row"><span class="venue-name">${escapeHtml(ep.name)}</span><span class="venue-state ${(ep.state || '').toLowerCase()}">${(ep.state || '').toUpperCase()}</span></div>`).join('')).join('');
    }
  }

  function escapeHtml(x) { return String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------------- başlangıç ---------------- */
  async function init() {
    try {
      const r = await fetch(API_BASE + '/api/state');
      state.last = await r.json();
      if (state.last.session && state.last.session.symbol) state.selectedCoin = state.last.session.symbol;
    } catch (_) {}
    await loadCoins();
    connectSSE();
    setInterval(renderWalls, 2000);
    render();
  }
  init();
})();
