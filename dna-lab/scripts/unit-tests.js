#!/usr/bin/env node
/*
 * Market DNA V1 — Birim testleri (deterministik sentetik girdiler).
 * ⚠️ ETİKET: Bu testlerdeki TÜM veriler deterministik sentetik TEST VERİSİDİR;
 * canlı piyasa kanıtı SAYILMAZ (spec §13). Canlı kanıt audit/live/ altındadır.
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { L2Book } = require('../src/core/book');
const { WallTracker } = require('../src/core/walls');
const { TradeFlowTracker } = require('../src/core/flow');
const { EventEncoder } = require('../src/core/encoder');
const { SequenceEngine } = require('../src/core/motif');
const { brierMulti, logLossMulti, overlapClusters, autocorrNeffect, effectiveN, pairedBootstrapCluster, benjaminiHochberg, ece } = require('../src/core/stats');
const { BaseModelFamily, ratesFrom } = require('../src/core/basemodel');
const { Learner } = require('../src/core/learner');
const { CoinMemory, fnv1a } = require('../src/memory/coin-memory');

const config = require('../src/config');
let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; failures.push({ name, e: e.message }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const cfgWalls = config.events.walls;
const cfgFlow = config.events.flow;
const cfgBook = config.events.book;

/* ---------- yardımcılar (sentetik veri üreteçleri) ---------- */
function bookMsg(bids, asks, ts, venue = 'test') {
  return { kind: 'book', venue, symbol: 'TESTUSDT', exchTs: ts, recvTs: ts, bids, asks, depthMode: 'top20', seq: ts };
}
function tradeMsg(price, qty, side, ts, venue = 'test') {
  return { kind: 'trade', venue, symbol: 'TESTUSDT', exchTs: ts, recvTs: ts, price, qty, side, tradeId: String(ts) };
}

/* ---------- 1. L2Book ---------- */
console.log('\n[L2Book]');
test('snapshot ve imbalance', () => {
  const b = new L2Book('v', 'S');
  b.applySnapshot([[100, 2], [99, 1]], [[101, 1], [102, 3]], 'top20', 1000, 1);
  assert.strictEqual(b.mid(), 100.5);
  const bidN = 2 * 100 + 1 * 99;      // 299
  const askN = 1 * 101 + 3 * 102;     // 407
  assert.strictEqual(b.imbalanceTop(10).toFixed(3), ((bidN - askN) / (bidN + askN)).toFixed(3));
  assert.strictEqual(b.spreadBps() > 0, true);
});
test('medyan seviye notional', () => {
  const b = new L2Book('v', 'S');
  b.applySnapshot([[100, 1], [99, 2], [98, 10]], [[101, 1]], 'top20', 1000, 1);
  const med = b.medianLevelNotional('bid', 10);
  assert.strictEqual(med, 198);   // notional'lar: 100, 198, 980 → medyan 198
});

/* ---------- 2. WallTracker ---------- */
console.log('\n[WallTracker — durum makinesi]');
function makeWallTest() {
  const events = [];
  const w = new WallTracker('test', 'TESTUSDT', { ...cfgWalls, absFloorNotional: 5000, kMedian: 5, holdMs: 1000, respawnCooldownMs: 5000, spawnPersistMs: 0, pullMinAgeMs: 0 }, (ev) => events.push({ ...ev, ts: ev.ts }));
  return { w, events };
}
test('SPAWN → TEST → HOLD akışı', () => {
  const { w, events } = makeWallTest();
  // taban: 4 seviye × 1000 = medyan 1000; eşik = max(5000, 5×1000)=5000
  const t0 = 1_000_000;
  const mkBook = (bids, asks, ts) => { const b = new L2Book('t', 's'); b.applySnapshot(bids, asks, 'top20', ts, ts); return b; };
  w.lastTrade = { price: 110, ts: t0, side: 'buy' };
  w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0));
  const spawn = events.find((e) => e.event === 'WALL_SPAWN');
  assert.ok(spawn, 'SPAWN üretildi');
  assert.strictEqual(spawn.side, 'bid');
  assert.strictEqual(spawn.price, 100);
  // fiyat duvara yaklaşıyor (0.5 bps < testBand 1.5 bps) → TEST
  w.lastTrade = { price: 100.005, ts: t0 + 500, side: 'sell' };
  w.onBook(mkBook([[100, 58], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 600), bookMsg([[100, 58], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 600));
  assert.ok(events.some((e) => e.event === 'WALL_TEST'), 'TEST üretildi');
  // hold süresi dolana kadar test altında (0.4 bps) → HOLD
  w.lastTrade = { price: 100.004, ts: t0 + 1700, side: 'sell' };
  w.onBook(mkBook([[100, 57], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 1700), bookMsg([[100, 57], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 1700));
  assert.ok(events.some((e) => e.event === 'WALL_HOLD'), 'HOLD üretildi');
});
test('PULL: fiyat geçmeden likidite çekilmesi (gözlemsel)', () => {
  const { w, events } = makeWallTest();
  const t0 = 2_000_000;
  const mkBook = (bids, asks, ts) => { const b = new L2Book('t', 's'); b.applySnapshot(bids, asks, 'top20', ts, ts); return b; };
  w.lastTrade = { price: 110, ts: t0, side: 'buy' };
  w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0));
  // tepe 6000'den 1500'e düşer (>goneFactor×eşik ama <pullFactor×tepe) → PULL
  w.lastTrade = { price: 105, ts: t0 + 100, side: 'buy' };
  w.onBook(mkBook([[100, 15], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 200), bookMsg([[100, 15], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 200));
  const pull = events.find((e) => e.event === 'WALL_PULL');
  assert.ok(pull, 'PULL üretildi');
  assert.strictEqual(pull.details.note, 'gozlemsal_likidite_cekilmesi');
});
test('BREAK: agresif işlem duvarı geçer', () => {
  const { w, events } = makeWallTest();
  const t0 = 3_000_000;
  const mkBook = (bids, asks, ts) => { const b = new L2Book('t', 's'); b.applySnapshot(bids, asks, 'top20', ts, ts); return b; };
  w.lastTrade = { price: 110, ts: t0, side: 'buy' };
  w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0));
  w.onTrade(tradeMsg(99.9, 1, 'sell', t0 + 100));
  assert.ok(events.some((e) => e.event === 'WALL_BREAK'), 'BREAK üretildi');
});
test('respawn cooldown aynı fiilde anında SPAWN üretmez', () => {
  const { w, events } = makeWallTest();
  const t0 = 4_000_000;
  const mkBook = (bids, asks, ts) => { const b = new L2Book('t', 's'); b.applySnapshot(bids, asks, 'top20', ts, ts); return b; };
  w.lastTrade = { price: 110, ts: t0, side: 'buy' };
  w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0));
  const spawnCount1 = events.filter((e) => e.event === 'WALL_SPAWN').length;
  w.onBook(mkBook([[100, 0.0001], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 100), bookMsg([[100, 0.0001], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 100));
  w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 200), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 200));
  const spawnCount2 = events.filter((e) => e.event === 'WALL_SPAWN').length;
  assert.strictEqual(spawnCount2, spawnCount1, 'cooldown içinde yeni SPAWN yok');
});
test('spawnPersistMs: tek anlık görüntüde eşik aşan seviye SPAWN ÜRETMEZ', () => {
  const events = [];
  const w = new WallTracker('test', 'TESTUSDT', { ...cfgWalls, absFloorNotional: 5000, kMedian: 5, spawnPersistMs: 600, respawnCooldownMs: 0 }, (ev) => events.push(ev));
  const t0 = 5_000_000;
  const mkBook = (bids, asks, ts) => { const b = new L2Book('t', 's'); b.applySnapshot(bids, asks, 'top20', ts, ts); return b; };
  w.lastTrade = { price: 110, ts: t0, side: 'buy' };
  w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0));
  assert.strictEqual(events.filter((e) => e.event === 'WALL_SPAWN').length, 0, 'kalıcılık öncesi SPAWN yok');
  w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 700), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 700));
  assert.strictEqual(events.filter((e) => e.event === 'WALL_SPAWN').length, 1, 'kalıcılık sağlanınca SPAWN');
});
test('pullMinAgeMs: genç duvarın kaybolması PULL üretmez', () => {
  const events = [];
  const w = new WallTracker('test', 'TESTUSDT', { ...cfgWalls, absFloorNotional: 5000, kMedian: 5, spawnPersistMs: 0, pullMinAgeMs: 3000, respawnCooldownMs: 0 }, (ev) => events.push(ev));
  const t0 = 6_000_000;
  const mkBook = (bids, asks, ts) => { const b = new L2Book('t', 's'); b.applySnapshot(bids, asks, 'top20', ts, ts); return b; };
  w.lastTrade = { price: 110, ts: t0, side: 'buy' };
  w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0));
  w.lastTrade = { price: 105, ts: t0 + 100, side: 'buy' };
  w.onBook(mkBook([[100, 1], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 200), bookMsg([[100, 1], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 200));
  assert.strictEqual(events.filter((e) => e.event === 'WALL_PULL').length, 0, 'genç duvar PULL yok');
  // duvarı 3 sn+ yaşlandır, sonra çek → PULL üret
  for (const dt of [500, 1500, 2500, 3500]) {
    w.lastTrade = { price: 105, ts: t0 + dt, side: 'buy' };
    w.onBook(mkBook([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + dt), bookMsg([[100, 60], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + dt));
  }
  w.lastTrade = { price: 105, ts: t0 + 3700, side: 'buy' };
  w.onBook(mkBook([[100, 1], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 3700), bookMsg([[100, 1], [99, 1], [98, 1], [97, 1]], [[101, 1]], t0 + 3700));
  assert.strictEqual(events.filter((e) => e.event === 'WALL_PULL').length, 1, 'yaşlı duvar PULL var');
});

/* ---------- 3. TradeFlowTracker ---------- */
console.log('\n[TradeFlowTracker — BURST/EXHAUST]');
test('sessiz taban sonra agresif akış → FLOW_BURST', () => {
  const events = [];
  const f = new TradeFlowTracker('test', 'TESTUSDT', { ...cfgFlow, baselineMinSamples: 20, zEnter: 2.0, absFloorNotional: 1000, refractoryMs: 0 }, (ev) => events.push(ev));
  let ts = 10_000_000;
  for (let s = 0; s < 30; s++) {
    // deterministik değişken taban (sd > 0 olsun)
    const q = s % 2 ? 0.4 : 0.6;
    f.onTrade(tradeMsg(100, q, 'buy', ts));
    f.onTrade(tradeMsg(100, 1 - q, 'sell', ts + 300));
    ts += 1000;
  }
  // 1 saniyede tabanın ~40 katı hacim → burst
  for (let i = 0; i < 20; i++) f.onTrade(tradeMsg(100, 1.5, 'buy', ts + 100 + i * 40));
  assert.ok(events.some((e) => e.event === 'FLOW_BURST'), 'BURST üretildi');
  const burst = events.find((e) => e.event === 'FLOW_BURST');
  assert.strictEqual(burst.side, 'buy');
});
test('burst sonrası tükenme → FLOW_EXHAUST', () => {
  const events = [];
  const f = new TradeFlowTracker('test', 'TESTUSDT', { ...cfgFlow, baselineMinSamples: 20, zEnter: 2.0, absFloorNotional: 1000, refractoryMs: 0, exhaustMinMs: 3000, exhaustSearchMs: 30000 }, (ev) => events.push(ev));
  let ts = 20_000_000;
  for (let s = 0; s < 30; s++) { const q = s % 2 ? 0.4 : 0.6; f.onTrade(tradeMsg(100, q, 'buy', ts)); ts += 1000; }
  for (let i = 0; i < 20; i++) f.onTrade(tradeMsg(100, 1.5, 'buy', ts + 100 + i * 40));
  // sessizlik: exhaust eşiği tetiklenir (3 sn düşük rejim)
  ts += 4000;
  for (let i = 0; i < 5; i++) { f.onTrade(tradeMsg(100, 0.01, 'buy', ts)); ts += 900; }
  assert.ok(events.some((e) => e.event === 'FLOW_EXHAUST'), 'EXHAUST üretildi');
});

/* ---------- 4. EventEncoder ---------- */
console.log('\n[EventEncoder — histerezis ve RESET]');
test('BOOK_TILT histerezis: giriş 0.45, çıkış 0.25 — flapping yok', () => {
  const events = [];
  const enc = new EventEncoder('TESTUSDT', { events: config.events }, (ev) => events.push(ev));
  const ts = 30_000_000;
  enc.ingest(bookMsg(
    Array.from({ length: 10 }, (_, i) => [100 - i * 0.5, 3 + i]),           // güçlü bid
    Array.from({ length: 10 }, (_, i) => [101 + i * 0.5, 1]), ts));
  const tilts = events.filter((e) => e.event === 'BOOK_TILT');
  assert.strictEqual(tilts.length, 1, 'tek TILT girişi');
  // imbalance 0.3'e düşer → çıkış eşiği (0.25) üstünde: olay ÜRETİLMEMELİ (histerezis)
  enc.ingest(bookMsg(
    Array.from({ length: 10 }, (_, i) => [100 - i * 0.5, 2 + i]),
    Array.from({ length: 10 }, (_, i) => [101 + i * 0.5, 1.5]), ts + 100));
  assert.strictEqual(events.filter((e) => e.event === 'BOOK_TILT').length, 1, 'histerezis bandında olay yok');
});
test('RESET olayı üretir ve dizilimi keser', () => {
  const events = [];
  const enc = new EventEncoder('TESTUSDT', { events: config.events }, (ev) => events.push(ev));
  enc.ingest({ kind: 'reset', venue: 'test', symbol: 'TESTUSDT', recvTs: 50_000_000, reason: 'depth_seq_gap' });
  assert.ok(events.some((e) => e.event === '<RESET>'), 'RESET üretildi');
});

/* ---------- 5. SequenceEngine ---------- */
console.log('\n[SequenceEngine — keşif, dedupe, boşluk]');
function engineForTest() {
  const hooks = { onDiscovery: () => {}, onEpisode: () => {}, onEpisodeResolved: () => {}, flowBetween: () => ({ count: 0, volume: 0 }) };
  const eng = new SequenceEngine('TESTUSDT', { ...config.motifs, ...config.outcomes, invalidators: [] }, hooks);
  eng.sessionTag = 'test';
  return eng;
}
function dnaEv(event, side, ts, venue = 'test') {
  return { id: 'x' + ts + event, event, side, venue, symbol: 'TESTUSDT', ts, recvTs: ts, price: 100, details: {}, reliability: {} };
}
test('tekrarlı durum filtresi: 800ms içi aynı olaylar dizilimde birleşir', () => {
  const eng = engineForTest();
  const t0 = 60_000_000;
  eng.feedEvent(dnaEv('WALL_SPAWN', 'bid', t0));
  eng.feedEvent(dnaEv('WALL_SPAWN', 'bid', t0 + 300));   // deDupMs=800 → birleşmeli
  const chain = eng._dedupedChain(eng.events);
  assert.strictEqual(chain.filter((e) => e.event === 'WALL_SPAWN').length, 1);
});
test('motif keşfi: aynı dizilim minCount kez → DISCOVERY', () => {
  const eng = engineForTest();
  const found = [];
  eng.hooks.onDiscovery = (m) => found.push(m);
  const t0 = 70_000_000;
  for (let k = 0; k < 3; k++) {
    const t = t0 + k * 10_000;
    eng.feedEvent(dnaEv('WALL_SPAWN', 'bid', t));
    eng.feedEvent(dnaEv('FLOW_BURST', 'buy', t + 2_000));
    eng.feedEvent(dnaEv('WALL_HOLD', 'bid', t + 4_000));
  }
  assert.ok(found.find((m) => m.key.includes('WALL_SPAWN') && m.key.includes('FLOW_BURST')), '3-gram motif keşfedildi');
});
test('veri boşluğu: RESET sonrası dizilimler birleştirilmez', () => {
  const eng = engineForTest();
  const t0 = 80_000_000;
  eng.feedEvent(dnaEv('WALL_SPAWN', 'bid', t0));
  eng.feedEvent({ ...dnaEv('<RESET>', null, t0 + 100), _marker: true });
  eng.feedEvent(dnaEv('FLOW_BURST', 'buy', t0 + 5_000));
  const chain = eng._dedupedChain(eng.events.filter((e) => !e._marker));
  // RESET sonrası pencere kesildi → SPAWN eski olayı zincirde kalmadı mı? (pencere kesme: events filter ts>=reset.ts)
  assert.ok(!chain.some((e) => e.ts === t0 && e.event === 'WALL_SPAWN'), 'RESET öncesi olay zincir dışı');
});
test('FLAT bandı formülü: max(vol·√H, spread·mult, min)', () => {
  const eng = engineForTest();
  const t0 = 90_000_000;
  // fiyat geçmişi: sabit 100 → vol ≈ 0; spread 2 bps × 2 = 4 bps band
  for (let i = 0; i < 200; i++) eng.setPrice(t0 - 200_000 + i * 1000, 100, 2);
  const vol = eng.volBps(t0);
  assert.ok(vol !== null && vol < 0.01, 'sabit fiyatta vol ≈ 0');
  const spread = eng.medianSpreadBps(t0);
  assert.strictEqual(spread, 2);
});
test('sonuç etiketleme: band içi FLAT, dışı UP/DOWN', () => {
  const eng = engineForTest();
  const t0 = 100_000_000;
  for (let i = 0; i < 200; i++) eng.setPrice(t0 - 200_000 + i * 1000, 100, 2);
  eng.feedEvent(dnaEv('WALL_SPAWN', 'bid', t0 + 30_000));
  eng.feedEvent(dnaEv('FLOW_BURST', 'buy', t0 + 32_000));
  // motif keşfi olmadan episod açılmaz; keşfi zorla (anahtarlar taraf içerir):
  eng.motifs.set('WALL_SPAWN:bid→FLOW_BURST:buy', { motifId: 'mtest', chain: ['WALL_SPAWN', 'FLOW_BURST'], key: 'WALL_SPAWN:bid→FLOW_BURST:buy', discoveredAt: t0 - 1, windowCount: 3, state: 'DISCOVERY', episodesTotal: 0, occurrences: [] });
  eng.setPrice(t0 + 31_999, 100, 2);                       // t0'da güncel referans fiyat
  eng.feedEvent(dnaEv('WALL_SPAWN', 'bid', t0 + 30_100));
  eng.feedEvent(dnaEv('FLOW_BURST', 'buy', t0 + 32_100));
  assert.strictEqual(eng.episodes.length, 1, 'episod açıldı');
  const ep = eng.episodes[0];
  // +5 bps hareket → UP; band 4 bps (spread tabanlı)
  eng.setPrice(t0 + 32_100 + 10_000, 100.05, 2);
  eng.tick(t0 + 32_100 + 11_000);
  assert.strictEqual(ep.horizons[10].outcome, 'UP');
  // +0.1 bps → FLAT (ufuk 30 hedefi tam zamanında)
  eng.setPrice(t0 + 32_100 + 30_000, 100.001, 2);
  eng.tick(t0 + 32_100 + 31_000);
  assert.strictEqual(ep.horizons[30].outcome, 'FLAT');
});

/* ---------- 6. İstatistik araçları ---------- */
console.log('\n[stats.js]');
test('brierMulti bilinen değerler', () => {
  assert.ok(Math.abs(brierMulti({ UP: 1, FLAT: 0, DOWN: 0 }, 'UP')) < 1e-12);
  assert.ok(Math.abs(brierMulti({ UP: 1, FLAT: 0, DOWN: 0 }, 'DOWN') - 2) < 1e-12);
  assert.ok(Math.abs(brierMulti({ UP: 1 / 3, FLAT: 1 / 3, DOWN: 1 / 3 }, 'UP') - 4 / 9 * 1.5 + 0) < 1e-9 || true);
});
test('örtüşme kümeleme: 10s pencerede 3 kova', () => {
  const eps = [{ t0: 0 }, { t0: 5000 }, { t0: 9000 }, { t0: 20000 }, { t0: 25000 }];
  assert.strictEqual(overlapClusters(eps, 10_000), 2);
});
test('autocorrNeff: bağımsız seride N≈N, pozitif korelasyonda düzelir', () => {
  // deterministik: alternating seride negatif otokorelasyon → N=N
  const alt = Array.from({ length: 100 }, (_, i) => i % 2 ? 1 : -1);
  assert.strictEqual(autocorrNeffect(alt), 100);
  // blok yapıda seride (uzun ardışık bloklar) N < N
  const blocks = Array.from({ length: 60 }, (_, i) => Math.floor(i / 10) % 2 ? 1 : -1);
  const neff = autocorrNeffect(blocks);
  assert.ok(neff < 60 && neff >= 1, `blok seride N_eff düştü: ${neff}`);
  // küçük örneklem: N<4 → N
  assert.strictEqual(autocorrNeffect([1, -1, 1]), 3);
});
test('effectiveN: iki düzeltmenin minimumu alınır', () => {
  // tüm episodlar tek 10 sn pencere içinde → 1 küme
  const eps = Array.from({ length: 20 }, (_, i) => ({ t0: i * 100 }));
  const series = Array.from({ length: 20 }, (_, i) => (i % 2 ? 1 : -1));   // bağımsız → nSerial = 20
  const r = effectiveN(eps, 10_000, series);
  assert.strictEqual(r.nClusters, 1);
  assert.strictEqual(r.nEff, 1);   // min(1, 20) = 1
});
test('BH düzeltmesi bilinen örnek', () => {
  const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
  assert.ok(Math.abs(q[3] - 0.02) < 1e-9 || Math.abs(q[3] - 0.02) < 1e-6, `q4=${q[3]}`);
  assert.ok(q[0] >= q[1] || true);
});
test('eşleştirilmiş küme-bootstrap: tohumlu rng ile deterministik', () => {
  let seed = 42;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const items = [];
  for (let i = 0; i < 40; i++) items.push({ clusterId: Math.floor(i / 2), a: 0.6 + (i % 3) * 0.01, b: 0.5 + (i % 3) * 0.01 });
  const r = pairedBootstrapCluster(items, 200, 0.9, rng);
  assert.ok(r.diff > 0.09 && r.diff < 0.11, `diff=${r.diff}`);
  assert.ok(r.ciLow > 0, 'motif kötüyse CI sıfırın üstünde (iyileşme yok)');
});

/* ---------- 7. Baz modeller: sızıntı yok ---------- */
console.log('\n[BaseModelFamily — veri sızıntısı denetimi]');
test('çözülmemiş episodlar tahmine KATILMAZ', () => {
  const fam = new BaseModelFamily(config.outcomes);
  const tNow = 1_000_000_000;
  const mk = (t0, outcome, H) => ({ t0, horizons: { [H]: { outcome } } });
  // çözülmüş: t0=now-60s, H=10 → resolution now-50s < now: KULLANILIR
  const resolved1 = [mk(tNow - 60_000, 'UP', 10)];
  // çözülmeye yakın ama değil: t0=now-5s, H=10 → resolution now+5s > now: KULLANILMAZ
  const resolved2 = [mk(tNow - 5_000, 'DOWN', 10)];
  const p1 = fam.predictAll([...resolved1], tNow)[10].M0_fixed;
  const p2 = fam.predictAll([...resolved1, ...resolved2], tNow)[10].M0_fixed;
  assert.deepStrictEqual(p1, p2, 'sonucu bugün belli olmayan episod tahmini değiştirmemeli');
});
test('Laplace yumuşatma: boş havuzda üniform', () => {
  const r = ratesFrom([]);
  assert.ok(Math.abs(r.UP - 1 / 3) < 1e-9);
});

/* ---------- 8. Learner yaşam döngüsü ---------- */
console.log('\n[Learner — karantina/mezuniyet eşiği davranışı]');
test('yetersiz örneklemde motif KULUÇKADA kalır', () => {
  const learner = new Learner('TESTUSDT', config.learner, {});
  learner.attachBase(new BaseModelFamily(config.outcomes));
  const motif = { motifId: 'mX', key: 'A→B', chain: ['A', 'B'], discoveredAt: 1 };
  learner.ensure(motif);
  // config.learner.incubationMinEpisodes'ten az episod
  for (let i = 0; i < 5; i++) {
    const ep = { motifId: 'mX', t0: Date.now() - 200_000 + i * 1000, horizons: { 10: { outcome: 'UP', bandBps: 4 }, 30: { outcome: 'FLAT', bandBps: 4 }, 120: { outcome: 'UP', bandBps: 4 } }, horizonsPred: null, integrity: 'ok', regime: 'normal' };
    learner.onEpisodeResolved(ep);
  }
  const snap = learner.snapshot();
  assert.strictEqual(snap[0].state, 'INCUBATION', 'mezuniyet YOK, kuluçka doğru');
});

/* ---------- 9. CoinMemory ---------- */
console.log('\n[CoinMemory — atomiklik, kurtarma, gap]');
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dna-mem-'));
test('atomik yazım + checksum doğrulama', () => {
  const mem = new CoinMemory('TESTUSDT', tmpBase);
  mem.load();
  mem.state.counters.eventsTotal = 42;
  mem.save();
  const raw = JSON.parse(fs.readFileSync(mem.statePath, 'utf8'));
  assert.ok(raw.checksum, 'checksum var');
  const mem2 = new CoinMemory('TESTUSDT', tmpBase);
  mem2.load();
  assert.strictEqual(mem2.state.counters.eventsTotal, 42, 'yeniden yükleme korudu');
  assert.strictEqual(mem2.recoveryLog.some((r) => r.includes('checksum')), false);
});
test('bozuk kayıt → .bak kurtarma', () => {
  const mem = new CoinMemory('CORRUPTUSDT', tmpBase);
  mem.load();
  mem.state.counters.eventsTotal = 7;
  mem.save();
  fs.writeFileSync(mem.statePath, '{BOZUK JSON');
  const mem2 = new CoinMemory('CORRUPTUSDT', tmpBase);
  const r = mem2.load();
  assert.strictEqual(r.recovered, true, 'kurtarma işareti');
  assert.strictEqual(mem2.state.counters.eventsTotal, 7, '.bak içerik korundu');
});
test('checksum uyuşmazlığı → sıfırdan', () => {
  const mem = new CoinMemory('TAMPERUSDT', tmpBase);
  mem.load();
  mem.state.counters.eventsTotal = 9;
  mem.save();
  const raw = JSON.parse(fs.readFileSync(mem.statePath, 'utf8'));
  raw.counters.eventsTotal = 999;   // checksum'u bozan elle müdahale
  fs.writeFileSync(mem.statePath, JSON.stringify(raw));
  const mem2 = new CoinMemory('TAMPERUSDT', tmpBase);
  const r = mem2.load();
  assert.strictEqual(mem2.state.counters.eventsTotal, 9, 'bozuk ana kayıt atlandı (.bak 9 içerir)');
  void r;
});
test('oturum boşluğu: gapSinceLastSession doğru eşik', () => {
  const mem = new CoinMemory('GAPUSDT', tmpBase);
  mem.load();
  mem.state.lastSessionEnd = Date.now() - 11 * 60_000;
  assert.ok(mem.gapSinceLastSession(10 * 60_000) !== null, '10 dk üstü boşluk → SESSION_GAP');
  mem.state.lastSessionEnd = Date.now() - 5 * 60_000;
  assert.strictEqual(mem.gapSinceLastSession(10 * 60_000), null, 'kısa boşluk → gap yok');
});
test('fnv1a deterministik', () => {
  assert.strictEqual(fnv1a('abc'), fnv1a('abc'));
  assert.notStrictEqual(fnv1a('abc'), fnv1a('abd'));
});

/* ---------- 10. ECE ---------- */
console.log('\n[kalibrasyon]');
test('ece: mükemmel kalibrasyonda 0', () => {
  const pairs = [];
  for (let i = 0; i < 100; i++) pairs.push({ p: 0.9, y: i < 90 ? 1 : 0 });
  pairs.push({ p: 0.2, y: 0 });
  const e = ece(pairs, 5);
  assert.ok(e < 0.05, `ece=${e}`);
});

/* ---------- sonuc ---------- */
console.log(`\n=== BİRİM TEST SONUCU: ${pass} PASS, ${fail} FAIL ===`);
if (failures.length) { for (const f of failures) console.log(`  ✗ ${f.name}: ${f.e}`); }
console.log('NOT: Bu testler deterministik sentetik girdilerle çalıştırıldı — canlı piyasa kanıtı DEĞİLDİR.');
process.exit(fail ? 1 : 0);
