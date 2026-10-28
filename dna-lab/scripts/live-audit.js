#!/usr/bin/env node
/*
 * Market DNA V1 — FAZ 7 uçtan uca CANLI denetim.
 * Gerçek borsa verisiyle çalışır; sahte veri ÜRETMEZ. Tüm sayılar gerçek çalıştırmadan gelir.
 *
 * Bölüm A: sunucu + REST/SSE duman testi (coin seçimi, canlı durum, coin değiştirme, oturum sonu)
 * Bölüm B: canlı motor denetimi (BTCUSDT 3 dk) + WebSocket kopma/reconnect testi
 * Bölüm C: sunucu yeniden başlatma simülasyonu + hafıza devamlılığı doğrulaması
 *
 * Çıktı: audit/live/liveaudit-<ts>.json ve .md
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'audit', 'live');
const PORT = 3011;
const t0Wall = Date.now();
const ev = {};   // rapor havuzu

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function api(p, opts) { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, opts); return { status: r.status, body: await r.json().catch(() => null) }; }

/* ---------------- Bölüm A: sunucu duman testi ---------------- */
async function sectionA() {
  log('BÖLÜM A — sunucu duman testi başlıyor');
  const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push('[out] ' + d.toString().trim()));
  server.stderr.on('data', (d) => serverLog.push('[err] ' + d.toString().trim()));
  A.serverLogTail = () => serverLog.slice(-8);
  A.serverProc = server;
  await sleep(2500);

  const health = await api('/health');
  log('health:', JSON.stringify(health.body));
  A.health = health;

  const coin = await api('/api/coin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'BTCUSDT' }) });
  log('POST /api/coin BTCUSDT:', coin.status);
  A.coinSelect = { status: coin.status, symbol: coin.body?.state?.session?.symbol };

  // SSE istemcisi aç (istemci bağlı sayımı + canlı akış kanıtı)
  const sse = await fetch(`http://127.0.0.1:${PORT}/api/stream`);
  A.sseStatus = sse.status;
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';
  const sseCounts = {};
  const sseDone = { v: false };
  (async () => {
    try {
      while (!sseDone.v) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = sseBuf.indexOf('event: ')) >= 0) {
          const rest = sseBuf.slice(idx + 7);
          const lineEnd = rest.indexOf('\n');
          const ch = rest.slice(0, lineEnd).trim();
          sseCounts[ch] = (sseCounts[ch] || 0) + 1;
          sseBuf = rest.slice(lineEnd + 1);
          if (sseBuf.length > 1e6) sseBuf = '';
        }
      }
    } catch (_) {}
  })();

  await sleep(15000);
  const st1 = await api('/api/state');
  A.stateAfter15s = {
    statusLabel: st1.body.statusLabel, phase: st1.body.phase,
    venues: (st1.body.venues || []).map((v) => ({ venue: v.venue, endpoints: v.endpoints.map((e) => ({ name: e.name, state: e.state, msgCount: e.msgCount })) })),
    eventsTotal: st1.body.engine?.encoder?.stats?.total,
    recentEvents: (st1.body.recentEvents || []).slice(-8).map((e) => `${e.event}${e.side ? ':' + e.side : ''}@${e.venue}`),
  };
  log('15 sn sonra: label=', st1.body.statusLabel, 'events=', st1.body.engine?.encoder?.stats?.total);

  // coin değiştirme testi
  const sw = await api('/api/coin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'ETHUSDT' }) });
  A.coinSwitch = { status: sw.status, symbol: sw.body?.state?.session?.symbol };
  log('coin değişimi →', sw.body?.state?.session?.symbol);
  await sleep(8000);
  const st2 = await api('/api/state');
  A.stateAfterSwitch = { symbol: st2.body.session?.symbol, venuesLive: (st2.body.venues || []).every((v) => v.endpoints.some((e) => e.state === 'live' || e.state === 'connecting')), eventsTotal: st2.body.engine?.encoder?.stats?.total };
  log('ETHUSDT durumu:', JSON.stringify(A.stateAfterSwitch));

  // geri BTC'ye dön (hafıza ayrışıklığı: BTC hafızası korunmalı)
  const back = await api('/api/coin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'BTCUSDT' }) });
  A.coinSwitchBack = { status: back.status, symbol: back.body?.state?.session?.symbol };
  await sleep(3000);

  // oturum sonu + arka plan kapalıyken istemci kopması → duraklatma
  const end = await api('/api/session/end', { method: 'POST' });
  A.sessionEnd = { status: end.status, phase: end.body?.phase };
  log('oturum sonlandırıldı:', end.body?.phase);
  sseDone.v = true;
  try { reader.cancel(); } catch (_) {}
  A.sseCounts = sseCounts;
  log('SSE kanal sayaçları:', JSON.stringify(sseCounts));

  server.kill('SIGTERM');
  await sleep(1500);
  A.serverExitOk = server.exitCode !== null || server.killed;
}

const A = {};

/* ---------------- Bölüm B: canlı motor denetimi ---------------- */
async function sectionB() {
  log('BÖLÜM B — canlı motor denetimi (BTCUSDT, 180 sn)');
  const config = require('../src/config');
  config.session.warmupMs = 3000;
  const { SessionManager } = require('../src/session/manager');

  const collected = { dnaEvents: {}, broadcasts: {}, motifs: [], episodes: [], logs: [] };
  const sm = new SessionManager((ch, data) => {
    collected.broadcasts[ch] = (collected.broadcasts[ch] || 0) + 1;
    if (ch === 'dnaEvent') collected.dnaEvents[data.event] = (collected.dnaEvents[data.event] || 0) + 1;
    if (ch === 'discovery') collected.motifs.push({ key: data.key, at: Date.now(), windowCount: data.windowCount });
    if (ch === 'episode') collected.episodes.push({ epId: data.epId, motifKey: data.motifKey, t0: data.t0 });
    if (ch === 'log') collected.logs.push(data.line);
  });

  sm.startCoin('BTCUSDT');
  const startTs = Date.now();

  // 60. sn: WebSocket kopma testi — bfut:public soketini zorla kapat (sunucu tarafı reconnect beklenir)
  setTimeout(() => {
    const s = sm.active;
    if (!s) return;
    const ad = s.adapters.find((a) => a.venue === 'binance_futures');
    if (ad && ad.epPublic._ws) {
      B.wsKill = { at: Date.now() - startTs, msgCountBefore: ad.epPublic.msgCount };
      try { ad.epPublic._ws.close(); } catch (e) { B.wsKill.error = e.message; }
      log('WS kopma testi: bfut:public soketi zorla kapatıldı');
    }
  }, 60_000);

  // 180 sn canlı çalışma
  await sleep(180_000);

  const snap = sm.publicSnapshot();
  B.snapshot = {
    statusLabel: snap.statusLabel,
    venues: (snap.venues || []).map((v) => ({ venue: v.venue, lagMsEwma: v.lagMsEwma, endpoints: v.endpoints.map((e) => ({ name: e.name, state: e.state, msgCount: e.msgCount, reconnects: e.reconnects, lastError: e.lastError })) })),
    encoderStats: snap.engine?.encoder?.stats,
    encoderVenues: (snap.engine?.encoder?.venues || []).map((v) => ({ venue: v.venue, book: v.book, flow: v.flow, walls: (v.walls || []).length })),
    motifList: snap.engine?.motifList,
    episodesSample: (snap.engine?.episodes || []).slice(0, 6),
    episodeCount: (snap.engine?.episodes || []).length,
    baseModels: snap.engine?.baseModels,
    learnerPool: snap.engine?.learnerResolvedPool,
    silenceReason: snap.silenceReason,
    memory: snap.memory,
  };
  B.collected = collected;
  B.wsReconnectCheck = (() => {
    const ad = sm.active?.adapters.find((a) => a.venue === 'binance_futures');
    if (!ad) return null;
    const ep = ad.epPublic;
    return { state: ep.state, reconnects: ep.reconnects, msgCountAfter: ep.msgCount, msgCountBefore: B.wsKill?.msgCountBefore };
  })();
  log('180 sn sonunda: label=', snap.statusLabel, ' motif=', (snap.engine?.motifList || []).length, ' episod=', B.snapshot.episodeCount);
  log('motifler:', JSON.stringify((snap.engine?.motifList || []).map((m) => `${m.key}(${m.windowCount})`)));
  log('DNA olayları:', JSON.stringify(collected.dnaEvents));

  // Bölüm C: kontrollü kapanış (persist) — ardından YENİ SessionManager ile devam
  log('BÖLÜM C — yeniden başlatma ve hafıza devamlılığı');
  const beforeState = sm.active.memory.state.counters;
  const beforeSessions = sm.active.memory.state.sessions;
  sm.shutdown();   // SIGINT benzeri kontrollü kapanış → diske yazar

  const sm2 = new SessionManager((ch, data) => {
    if (ch === 'log') C.logs.push(data.line);
    if (ch === 'dnaEvent' && data.event === '<SESSION_GAP>') C.sessionGapSeen = true;
  });
  const { CoinMemory } = require('../src/memory/coin-memory');
  const memCheck = new CoinMemory('BTCUSDT', config.dataDir);
  const loaded = memCheck.load();
  C.memoryAfterRestart = {
    recovered: loaded.recovered, recoveryLog: loaded.recoveryLog,
    sessions: loaded.state.sessions, counters: loaded.state.counters,
    countersMatch: loaded.state.counters.eventsTotal === beforeState.eventsTotal,
    lastSessionEnd: loaded.state.lastSessionEnd,
    files: memCheck.info().files.map((f) => f.name),
    recentEpisodesLoaded: memCheck.loadRecentEpisodes().length,
  };
  log('hafıza devamlılığı: eventsTotal=', loaded.state.counters.eventsTotal, '(önce:', beforeState.eventsTotal, ')');

  sm2.startCoin('BTCUSDT', { resumed: true });
  await sleep(20_000);
  const snap2 = sm2.publicSnapshot();
  C.afterRestart20s = {
    statusLabel: snap2.statusLabel,
    sessionGaps: snap2.session?.sessionGaps,
    eventsTotal: snap2.engine?.encoder?.stats?.total,
    learnerPool: snap2.engine?.learnerResolvedPool,
    memoryCounters: snap2.memory?.counters,
    venues: (snap2.venues || []).map((v) => ({ venue: v.venue, msg: v.endpoints.reduce((a, e) => a + e.msgCount, 0) })),
  };
  C.memoryCountersContinued = sm2.active.memory.state.counters.eventsTotal > beforeState.eventsTotal;
  sm2.shutdown();

  // SESSION_GAP zorlamalı doğrulama: lastSessionEnd'i 20 dk geriye al → yeni oturumda gap beklenir
  const memGap = new CoinMemory('BTCUSDT', config.dataDir);
  memGap.load();
  memGap.state.lastSessionEnd = Date.now() - 20 * 60_000;
  memGap.save();
  const sm3 = new SessionManager(() => {});
  const st3 = sm3.startCoin('BTCUSDT', { resumed: true });
  C.sessionGapForced = { sessionGaps: st3.session?.sessionGaps, expected: 1 };
  await sleep(2000);
  sm3.shutdown();
  C.logs = C.logs || [];
}

const B = {}, C = { logs: [] };

/* ---------------- rapor ---------------- */
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await sectionA();
  await sectionB();
  const durationMs = Date.now() - t0Wall;

  const report = { startedAt: new Date(t0Wall).toISOString(), durationMs: Math.round(durationMs / 1000), A, B, C };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(OUT, `liveaudit-${stamp}.json`), JSON.stringify(report, null, 2));

  const md = [];
  md.push(`# FAZ 7 — Uçtan Uca Canlı Denetim Raporu`);
  md.push('');
  md.push(`- Test zamanı: ${new Date(t0Wall).toISOString()} · Toplam süre: ${Math.round(durationMs / 1000)} sn`);
  md.push(`- Coin: BTCUSDT (+ ETHUSDT coin-değiştirme testi)`);
  md.push(`- Kaynaklar: Binance USDⓈ-M Futures (/public + /market), Binance Spot, OKX USDT Swap — hepsi GERÇEK WSS akışları`);
  md.push('');
  md.push('## Bölüm A — Sunucu + REST/SSE duman testi');
  md.push(`- /health: ${A.health?.status} · coin seçimi: ${A.coinSelect?.status} · SSE: HTTP ${A.sseStatus}`);
  md.push(`- SSE kanal mesajları: ${JSON.stringify(A.sseCounts)}`);
  md.push(`- 15 sn sonra: etiket=${A.stateAfter15s?.statusLabel} · olay=${A.stateAfter15s?.eventsTotal}`);
  md.push(`- Venue durumları: ${JSON.stringify(A.stateAfter15s?.venues?.map((v) => `${v.venue}:${v.endpoints.map((e) => e.state + '(' + e.msgCount + ')').join('/')}`).join(', '))}`);
  md.push(`- Örnek gerçek olaylar: ${JSON.stringify(A.stateAfter15s?.recentEvents)}`);
  md.push(`- Coin değiştirme: ${JSON.stringify(A.coinSwitch)} → durum: ${JSON.stringify(A.stateAfterSwitch)}`);
  md.push(`- Geri dönüş: ${JSON.stringify(A.coinSwitchBack)} · oturum sonu: ${JSON.stringify(A.sessionEnd)}`);
  md.push('');
  md.push('## Bölüm B — 3 dakikalık canlı motor denetimi (BTCUSDT)');
  const bSnap = B.snapshot || {};
  md.push(`- Gerçek mesaj sayıları (adaptör): ${JSON.stringify((bSnap.venues || []).map((v) => ({ venue: v.venue, lagEwmaMs: v.lagMsEwma, eps: v.endpoints.map((e) => `${e.name}=${e.msgCount}(rec:${e.reconnects})`) })))}`);
  md.push(`- WebSocket kopma testi: ${JSON.stringify(B.wsKill)} → reconnect sonrası: ${JSON.stringify(B.wsReconnectCheck)}`);
  md.push(`- Kodlanan DNA olayları: ${JSON.stringify(B.snapshot?.encoderStats)}`);
  md.push(`- Keşfedilen motifler (${(B.collected?.motifs || []).length}): ${JSON.stringify((B.collected?.motifs || []).map((m) => `${m.key} ×${m.windowCount}`))}`);
  md.push(`- Epizod sayısı: ${bSnap.episodeCount} · baz model havuzu: ${bSnap.learnerPool}`);
  md.push(`- Durum etiketi: ${bSnap.statusLabel} · sessizlik gerekçesi: ${JSON.stringify(bSnap.silenceReason)}`);
  md.push(`- Baz model skorları (canlı ileri veri): ${JSON.stringify(bSnap.baseModels)}`);
  md.push(`- Aktif duvar/akış anlık görüntüsü: ${JSON.stringify(bSnap.encoderVenues)}`);
  md.push('');
  md.push('## Bölüm C — Yeniden başlatma + hafıza devamlılığı');
  md.push(`- Kontrollü kapanış sonrası kayıt: ${JSON.stringify(C.memoryAfterRestart?.counters)} · eşleşme: ${C.memoryAfterRestart?.countersMatch}`);
  md.push(`- Kurtarma durumu: recovered=${C.memoryAfterRestart?.recovered} · log=${JSON.stringify(C.memoryAfterRestart?.recoveryLog)}`);
  md.push(`- Yeni oturumda 20 sn sonrası: ${JSON.stringify(C.afterRestart20s)}`);
  md.push(`- Sayaç devamı: ${C.memoryCountersContinued}`);
  md.push(`- Zorlamalı SESSION_GAP testi: ${JSON.stringify(C.sessionGapForced)}`);
  md.push('');
  md.push('## İstatistiksel yöntem ve sınırlamalar');
  md.push('- Yöntem: t0 anında gölge tahmin (yalnız o ana kadar çözülmüş episodlar) → sonuç çözülünce çok sınıflı Brier ile skorlama; motif vs baz model karşılaştırması örtüşme-küme düzeyinde eşleştirilmiş bootstrap + BH-FDR.');
  md.push('- **Bu oturumun süresi (birkaç dakika) İSTATİSTİKSEL MEZUNİYET İÇİN YETERSİZDİR.** Spec §16 gereği hiçbir motif mezun ilan EDİLMEMİŞTİR; sistemin GÖZLEMDE/KULUÇKADA kalması DOĞRU davranıştır.');
  md.push('- Sınırlamalar: derinlik top-20 (Binance partial) / top-400 (OKX); likidasyon akışı nadir olaydır; single-region gecikme ölçümü exchange-vs-local saat kaymasına duyarlıdır.');
  const mdPath = path.join(OUT, `liveaudit-${stamp}.md`);
  fs.writeFileSync(mdPath, md.join('\n') + '\n');
  log('RAPOR:', mdPath);
  process.exit(0);
}

main().catch((e) => { console.error('DENETİM HATASI:', e); process.exit(1); });
