'use strict';
/*
 * Market DNA V1 — Tek-coin oturum yöneticisi (spec §2.1, §10).
 * - Aynı anda yalnızca BİR coin aktif analiz edilir.
 * - Coin değişimi: aktif zincir kapatılır → durum diske yazılır → yeni coinin hafızası yüklenir.
 * - Arka plan kuluçka: istemci kopabilir; tarayıcı kapansına kesin güvenİLMEZ,
 *   oturum sonlandırma bağlantı zaman aşımı + açık uç + sunucu süreç yönetimiyle tasarlanır.
 */
const { EventEncoder } = require('../core/encoder');
const { SequenceEngine } = require('../core/motif');
const { Learner } = require('../core/learner');
const { BaseModelFamily } = require('../core/basemodel');
const { CoinMemory } = require('../memory/coin-memory');
const { BinanceFuturesAdapter } = require('../sources/binance-futures');
const { BinanceSpotAdapter } = require('../sources/binance-spot');
const { OkxSwapAdapter } = require('../sources/okx-swap');
const config = require('../config');

const PRIMARY = config.outcomes.primaryVenue;

class SessionManager {
  constructor(broadcast) {
    this.broadcast = broadcast || (() => {});
    this.active = null;            // aktif oturum paketi
    this.clients = 0;              // bağlı SSE istemcisi
    this.background = config.session.backgroundIncubationDefault;
    this._graceTimer = null;
    this._tickTimer = null;
    this.startedAt = Date.now();
    this.phase = 'idle';           // idle | running | paused | closing
    this.lastPauseReason = null;
  }

  /* ---------------- istemci yaşam döngüsü ---------------- */
  clientConnected() {
    this.clients += 1;
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    // Duraklatılmış oturumu sürdür (aynı coin, yeni oturum)
    if (this.phase === 'paused' && this.lastSymbol) {
      this.startCoin(this.lastSymbol, { resumed: true });
    }
  }

  clientDisconnected() {
    this.clients = Math.max(0, this.clients - 1);
    if (this.clients === 0 && this.phase === 'running' && !this.background) {
      // Tarayıcı kapandı varsayımı YAPILMAZ; yalnız zaman aşımı + kullanıcı tercihi
      this._graceTimer = setTimeout(() => {
        if (this.clients === 0 && !this.background) this.closeCoin('istemci_zaman_asimi_arka_plan_kapali');
      }, config.session.disconnectGraceMs);
    }
  }

  setBackground(flag) {
    this.background = !!flag;
    if (this.background && this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    this.broadcast('status', { phase: this.phase, background: this.background });
    return this.background;
  }

  /* ---------------- oturum aç/kapat ---------------- */
  startCoin(symbol, opts = {}) {
    symbol = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{4,20}$/.test(symbol)) throw new Error('geçersiz sembol: ' + symbol);
    if (this.active && this.active.symbol === symbol) return this.publicSnapshot();
    this.closeCoin('coin_degisimi');
    this.lastSymbol = symbol;

    const memory = new CoinMemory(symbol, config.dataDir);
    const loaded = memory.load();
    memory.sessionOpen();

    const session = {
      symbol, memory, startedAt: Date.now(), resumed: !!opts.resumed,
      warmupUntil: Date.now() + config.session.warmupMs,
      gapsEmitted: 0,
    };

    // --- motor bileşenleri ---
    const encoder = new EventEncoder(symbol, config, (ev) => this._onDnaEvent(session, ev));
    const learner = new Learner(symbol, config.learner, {
      onMotifUpdate: (m) => this.broadcast('motif', this._motifPublic(m)),
      onGraduated: (m) => {
        this.broadcast('status', { label: 'MEZUN MOTİF AKTİF', motifId: m.motifId });
        this._log(`MEZUNİYET: ${m.key} (ufuk ${m.graduatedHorizonSec}s) — metrikler: ${JSON.stringify(m.metrics)}`);
      },
      onQuarantined: (m, reason) => {
        this.broadcast('status', { label: 'KARANTINA', motifId: m.motifId, reason });
        this._log(`KARANTINA: ${m.key} — ${reason}`);
      },
      onInvalidation: (ep, m, first) => {
        this.broadcast('invalidation', { epId: ep.epId, motifId: m.motifId, by: first.event, at: first.ts });
        this._log(`YAPISAL GEÇERSİZLİK: ${ep.epId} — ${first.event}`);
      },
    });
    const base = new BaseModelFamily(config.outcomes);
    learner.attachBase(base);

    // Hafızadaki geçmiş episodları baz model havuzuna ekle (sızıntısız: t0 geçmişte)
    const memoryEps = memory.loadRecentEpisodes().map((e) => ({ t0: e.t0, horizons: e.horizons, motifId: e.motifId }));
    learner.resolvedPool.push(...memoryEps);

    const engine = new SequenceEngine(symbol, { ...config.motifs, ...config.outcomes, invalidators: config.learner.invalidators }, {
      flowBetween: (t1, t2) => encoder.flowBetween(t1, t2),
      makePredictions: (ep) => this._makePredictions(session, learner, base, ep),
      onEpisode: (ep, motif) => {
        learner.onEpisode(ep, motif);
        // Not: epizod diske yalnız ÇÖZÜMDE yazılır (çift kayıt önlenir); aktif epizotlar
        // events jsonl ve state üzerinden izlenebilir.
        this.broadcast('episode', { epId: ep.epId, motifKey: ep.motifKey, t0: ep.t0, regime: ep.regime, chain: ep.chain.length });
      },
      onEpisodeResolved: (ep) => {
        learner.onEpisodeResolved(ep);
        learner.evaluateCancellation(ep);
        memory.recordEpisode(ep);
        this.broadcast('episodeResolved', { epId: ep.epId, motifKey: ep.motifKey, outcomes: Object.fromEntries(Object.entries(ep.horizons).map(([H, h]) => [H, h.outcome])) });
      },
      onDiscovery: (motif) => {
        learner.ensure(motif);
        this.broadcast('discovery', { motifId: motif.motifId, key: motif.key, windowCount: motif.windowCount });
        this._log(`MOTİF KEŞFEDİLDİ: ${motif.key} (pencere içinde ${motif.windowCount} görülme)`);
      },
      onMotif: () => {},
    });

    // --- adaptörler ---
    const adapters = [];
    if (config.sources.binanceFutures.enabled) adapters.push(new BinanceFuturesAdapter(symbol, config.sources.binanceFutures, (m) => this._onSource(session, m, PRIMARY)));
    if (config.sources.binanceSpot.enabled) adapters.push(new BinanceSpotAdapter(symbol, config.sources.binanceSpot, (m) => this._onSource(session, m, PRIMARY)));
    if (config.sources.okxSwap.enabled) adapters.push(new OkxSwapAdapter(symbol, config.sources.okxSwap, (m) => this._onSource(session, m, PRIMARY), config.symbolFormat.okx));

    // --- oturum boşluğu (SESSION_GAP) — kablolamadan SONRA üretilir ---
    const gap = memory.gapSinceLastSession(config.session.sessionGapMs);

    session.adapters = adapters;
    session.encoder = encoder;
    session.engine = engine;
    session.learner = learner;
    session.base = base;
    this.active = session;
    this.phase = 'running';
    this.lastPauseReason = null;

    for (const a of adapters) a.start();
    if (!this._tickTimer) {
      this._tickTimer = setInterval(() => this._tick(), 1000);
    }
    // Oturum boşluğu olayı (motor hazır olduktan sonra)
    if (gap) {
      session.gapsEmitted += 1;
      encoder.ingest({ kind: 'sessionGap', recvTs: Date.now(), gapMs: gap.gapMs, lastSessionEnd: gap.lastSessionEnd });
      this._log(`SESSION_GAP: ${(gap.gapMs / 60000).toFixed(1)} dk boşluk — aktif tahminler geçersiz sayıldı`);
    }
    this.broadcast('status', { phase: 'running', symbol, resumed: !!opts.resumed, sessionGap: !!gap });
    this._log(`OTURUM: ${symbol} analizi başladı (${adapters.length} kaynak, hafıza: ${loaded.recovered ? 'kurtarıldı' : 'yüklendi'})`);
    return this.publicSnapshot();
  }

  closeCoin(reason) {
    if (!this.active) { this.phase = this.phase === 'paused' ? 'paused' : 'idle'; return; }
    const s = this.active;
    this.phase = 'closing';
    // Aktif olay zinciri kapatılır: <RESET> işareti + durum diske yazılır
    s.encoder && s.encoder.ingest({ kind: 'reset', venue: 'system', symbol: s.symbol, recvTs: Date.now(), reason: 'session_close:' + reason });
    for (const a of s.adapters) { try { a.stop(); } catch (_) {} }
    s.learner && s.memory.syncLearner(s.learner.snapshot());
    s.base && s.memory.syncBaseScores(s.base.snapshot());
    s.memory.sessionClose();
    this.active = null;
    this.phase = this.clients === 0 && !this.background ? 'paused' : 'idle';
    this.lastPauseReason = this.phase === 'paused' ? reason : null;
    this.broadcast('status', { phase: this.phase, reason });
    this._log(`OTURUM KAPATILDI: ${s.symbol} — neden: ${reason}`);
  }

  endSession() { this.closeCoin('kullanici_talebi'); }

  /* ---------------- veri akışı ---------------- */
  _onSource(session, msg, primaryVenue) {
    const { encoder, engine } = session;
    if (msg.kind === 'venueStatus' || msg.kind === 'venueStale') {
      // kitap stale işaretle
      if (msg.kind === 'venueStale' && encoder.books.has(msg.endpoint ? msg.endpoint.name.split(':')[0] : msg.venue)) {
        encoder.books.get(msg.venue).stale = true;
      }
      this.broadcast('venue', msg);
      return;
    }
    encoder.ingest(msg);
    if (msg.kind === 'book' || msg.kind === 'ticker' || msg.kind === 'trade') {
      if (msg.venue === primaryVenue) {
        const book = encoder.books.get(msg.venue);
        const price = msg.kind === 'trade' ? msg.price : (book && book.mid());
        const spread = book && book.spreadBps();
        if (price) engine.setPrice(msg.recvTs, price, spread);
      }
    }
  }

  _onDnaEvent(session, ev) {
    const { engine, memory } = session;
    memory.recordEvent(ev);
    engine.feedEvent(ev);
    engine.feedInvalidator(ev);
    // Aktif mezun motif için yapısal geçersizlik denetimi
    for (const m of session.learner.motifs.values()) {
      if (m.state === 'GRADUATED') {
        const ep = session.engine.episodes.filter((e) => e.motifId === m.motifId && !e.resolvedAll).slice(-1)[0];
        if (ep) session.learner.checkInvalidation(ep, { motifId: m.motifId });
      }
    }
    this.broadcast('dnaEvent', {
      id: ev.id, event: ev.event, side: ev.side, venue: ev.venue, ts: ev.ts, price: ev.price,
      details: ev.details, reliability: ev.reliability,
    });
  }

  _makePredictions(session, learner, base, ep) {
    // YALNIZCA ep.t0 anında bilinen veri (sızıntısız)
    const motifModel = {};
    const baseModels = {};
    const lmotif = learner.motifs.get(ep.motifId);
    for (const H of config.outcomes.horizonsSec) {
      motifModel[H] = lmotif ? learner._motifPredFor(lmotif, H, ep.t0) : null;
      baseModels[H] = base.predictAll(learner.resolvedPool, ep.t0)[H];
    }
    return { motifModel, baseModels };
  }

  /* ---------------- periyodik işler ---------------- */
  _tick() {
    const s = this.active;
    if (!s || this.phase !== 'running') return;
    const now = Date.now();
    s.engine.tick(now);
    // periyodik kalıcılık
    if (now - (s._lastPersist || 0) > config.session.persistIntervalMs) {
      s._lastPersist = now;
      s.learner && s.memory.syncLearner(s.learner.snapshot());
      s.base && s.memory.syncBaseScores(s.base.snapshot());
      s.memory.save();
    }
    this.broadcast('state', this.publicSnapshot());
  }

  _motifPublic(m) {
    return {
      motifId: m.motifId, key: m.key, chain: m.chain, state: m.state,
      episodes: m.episodes.length, metrics: m.metrics, quarantineReason: m.quarantineReason,
      invalidators: m.invalidators, cancelStats: m.cancelStats,
      graduatedHorizonSec: m.graduatedHorizonSec ?? null,
    };
  }

  statusLabel() {
    const s = this.active;
    if (this.phase === 'paused') return 'DURAKLATILDI';
    if (this.phase === 'idle') return 'BEKLEMEDE';
    if (this.phase === 'closing') return 'KAPANIYOR';
    if (!s) return 'BEKLEMEDE';
    // VERİ KOPUK: hiçbir kitap canlı değilse
    const books = [...s.encoder.books.values()];
    const anyLive = books.length > 0 && books.some((b) => b.hasBook() && !b.stale);
    if (!anyLive) return 'VERİ KOPUK';
    if (Date.now() < s.warmupUntil) return 'GÖZLEMDE';
    const motifs = [...s.learner.motifs.values()];
    const graduated = motifs.filter((m) => m.state === 'GRADUATED');
    const pendingEps = s.engine.episodes.filter((e) => !e.resolvedAll);
    const invalidated = graduated.some((m) => s.engine.episodes.some((e) => e.motifId === m.motifId && !e.resolvedAll && e.cancelled));
    if (graduated.length && invalidated) return 'YAPISAL GEÇERSİZLİK';
    if (graduated.length) return 'MEZUN MOTİF AKTİF';
    if (motifs.some((m) => m.state === 'VALIDATION')) return 'DOĞRULANIYOR';
    if (motifs.some((m) => m.state === 'INCUBATION' && m.episodes.length > 0)) return 'KULUÇKADA';
    if (motifs.length > 0 || pendingEps.length > 0) return 'MOTİF KEŞFEDİLDİ';
    return 'GÖZLEMDE';
  }

  publicSnapshot() {
    const s = this.active;
    const base = {
      ts: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      phase: this.phase,
      background: this.background,
      clients: this.clients,
      statusLabel: this.statusLabel(),
      session: s ? {
        symbol: s.symbol, startedAt: s.startedAt, warmupUntil: s.warmupUntil,
        sessionGaps: s.gapsEmitted,
      } : { symbol: this.lastSymbol || null, startedAt: null },
    };
    if (!s) return base;
    const venues = s.adapters.map((a) => a.status());
    const graduated = [...s.learner.motifs.values()].filter((m) => m.state === 'GRADUATED');
    const activeGrad = graduated[0];
    let prediction = null;
    if (activeGrad) {
      const H = activeGrad.graduatedHorizonSec;
      const ep = s.engine.episodes.filter((e) => e.motifId === activeGrad.motifId && !e.resolvedAll).slice(-1)[0];
      if (ep && ep.horizonsPred && ep.horizonsPred.motifModel && ep.horizonsPred.motifModel[H]) {
        prediction = {
          motifId: activeGrad.motifId, motifKey: activeGrad.motifKey, horizonSec: H,
          probs: ep.horizonsPred.motifModel[H],
          refPrice: ep.refPrice, t0: ep.t0, bandBps: ep.horizons[H].bandBps,
          invalidation: ep.cancelled ? { by: ep.cancelledBy, at: ep.cancelledAt, outcome: ep.cancelOutcome || null } : null,
          shadow: true,   // araştırma ajanı: gölge tahmin, işlem tavsiyesi değildir
        };
      }
    }
    return {
      ...base,
      venues,
      engine: {
        encoder: s.encoder.snapshot(),
        motifs: s.learner.snapshot(),
        motifList: s.engine.motifList(),
        episodes: s.engine.episodeList(25),
        baseModels: s.base.snapshot(),
        learnerResolvedPool: s.learner.resolvedPool.length,
      },
      activePrediction: prediction,
      silenceReason: this._silenceReason(s),
      memory: s.memory.info().state,
      recentEvents: this._recentEvents(s, 40),
    };
  }

  _recentEvents(s, n) {
    const evs = s.engine.events.filter((e) => !e._marker);
    return evs.slice(-n).map((e) => ({ event: e.event, side: e.side, venue: e.venue, ts: e.ts, price: e.price }));
  }

  /** "Neden sessiz?" gerekçesi — spec §17.7: kanıt yoksa sistem neden susuyor, açıklanır. */
  _silenceReason(s) {
    const motifs = [...s.learner.motifs.values()];
    if (Date.now() < s.warmupUntil) return { code: 'WARMUP', text: 'Oturum ısınıyor: olay kodlayıcı taban çizgisi oluşturuyor.' };
    if (!motifs.length) return { code: 'NO_MOTIF', text: 'Henüz keşfedilmiş motif yok: pencere içinde tekrarlanan olay dizilimi bulunamadı.' };
    for (const m of motifs) {
      const r = m.episodes.length;
      if (m.state === 'INCUBATION') {
        return { code: 'INCUBATION', motifId: m.motifId, text: `Kuluçkada: "${m.key}" — ${r} çözülmüş episod. Mezuniyet için ileri doğrulama ve etkin örneklem gerekir; kısa oturum verisiyle motif mezun İLAN EDİLMEZ.` };
      }
      if (m.state === 'VALIDATION') {
        return { code: 'VALIDATION', motifId: m.motifId, text: `Doğrulanıyor: "${m.key}" — ${r} episod. Etkin örneklem/lift koşulları henüz sağlanmadı.` };
      }
    }
    return null;
  }

  _log(line) {
    const entry = { ts: Date.now(), line };
    this.broadcast('log', entry);
    // oturum günlüğü (izlenebilirlik)
    const { appendJsonl } = require('../util');
    const { dayStamp } = require('../util');
    try { appendJsonl(`${config.auditDir}/live/session-${dayStamp(Date.now())}.jsonl`, entry); } catch (_) {}
  }

  shutdown() {
    this.closeCoin('kapatma');
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
  }
}

module.exports = { SessionManager };
