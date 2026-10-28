'use strict';
/*
 * Market DNA V1 — Olay Kodlayıcı.
 * Ham normalize piyasa mesajlarını anlamlı olay geçişlerine çevirir (spec §3-4).
 * Her olay zarfı: {id, event, side, venue, symbol, ts, recvTs, price, details, reliability}.
 * Yön anlamı YÜKLENMEZ; `side` yalnız gözlenen tarafı gösterir.
 */
const { L2Book } = require('./book');
const { WallTracker } = require('./walls');
const { TradeFlowTracker } = require('./flow');
const { makeId } = require('../util');

class EventEncoder {
  constructor(symbol, cfg, onEvent) {
    this.symbol = symbol;
    this.cfg = cfg;
    this.onEvent = onEvent;          // (event) => void
    this.books = new Map();          // venue → L2Book
    this.wallTrackers = new Map();   // venue → WallTracker
    this.flowTrackers = new Map();   // venue → TradeFlowTracker
    this.tiltState = new Map();      // venue → 'flat'|'bid'|'ask'
    this.lastTiltSign = new Map();   // venue → son işaret geçişleri [{ts, sign}]
    this.voidState = new Map();      // venue+side → {armed, baselineNotional, dropTs, lastEmitTs}
    this.sweepState = new Map();     // venue → {trades: [], highRef, lowRef, sweepHighTs, sweepLowTs, ...}
    this.lastEventAt = new Map();    // type|side|venue → ts (refractory)
    this.stats = { byType: {}, total: 0 };
    this.startedAt = Date.now();
  }

  _venueSet(venue) {
    if (!this.books.has(venue)) {
      this.books.set(venue, new L2Book(venue, this.symbol));
      const wcfg = this.cfg.events.walls;
      this.wallTrackers.set(venue, new WallTracker(venue, this.symbol, wcfg, (ev) => this._out(ev)));
      const fcfg = this.cfg.events.flow;
      this.flowTrackers.set(venue, new TradeFlowTracker(venue, this.symbol, fcfg, (ev) => this._out(ev)));
      this.tiltState.set(venue, 'flat');
      this.lastTiltSign.set(venue, []);
      this.voidState.set(venue, { bid: { armed: false, lastEmit: 0 }, ask: { armed: false, lastEmit: 0 } });
      this.sweepState.set(venue, { trades: [], sweepHighTs: 0, sweepLowTs: 0, refHigh: null, refLow: null, lastEmit: 0 });
    }
    return { book: this.books.get(venue), walls: this.wallTrackers.get(venue), flow: this.flowTrackers.get(venue) };
  }

  /** Normalleştirilmiş kaynak mesajını işle. */
  ingest(msg) {
    if (msg.kind === 'reset') {
      this._out({ event: '<RESET>', side: null, venue: msg.venue, symbol: this.symbol, ts: msg.recvTs, recvTs: Date.now(), price: null, details: { reason: msg.reason } });
      return;
    }
    if (msg.kind === 'sessionGap') {
      this._out({ event: '<SESSION_GAP>', side: null, venue: 'system', symbol: this.symbol, ts: msg.recvTs, recvTs: Date.now(), price: null, details: { gapMs: msg.gapMs, lastSessionEnd: msg.lastSessionEnd } });
      return;
    }
    if (msg.kind === 'venueStatus' || msg.kind === 'venueStale') return;   // durum API'den akar
    const { book, walls, flow } = this._venueSet(msg.venue);

    if (msg.kind === 'book') {
      book.applySnapshot(msg.bids, msg.asks, msg.depthMode, msg.exchTs, msg.seq);
      book.stale = false;
      walls.onBook(book, msg);
      this._checkTilt(book, msg);
      this._checkVoid(book, msg);
    } else if (msg.kind === 'trade') {
      walls.onTrade(msg);
      flow.onTrade(msg);
      this._checkSweep(msg);
    }
    // 'ticker' ve 'mark' olaya dönüştürülmez; durum/istatistik için tutulur (reliability ve panel).
  }

  _retriggerOk(type, side, venue, ts) {
    const key = `${type}|${side || '-'}|${venue}`;
    const refractory = type === 'FLOW_BURST' ? this.cfg.events.flow.refractoryMs
      : type === 'SWEEP_REJECT' ? this.cfg.events.sweep.refractoryMs
      : type === 'VOID_OPEN' ? this.cfg.events.book.voidRefractoryMs
      : type === 'MICRO_FLIP' ? this.cfg.events.book.flipWindowMs
      : 0;
    const last = this.lastEventAt.get(key) || 0;
    if (refractory && ts - last < refractory) return false;
    this.lastEventAt.set(key, ts);
    return true;
  }

  _out(ev) {
    const full = {
      id: makeId('ev'),
      event: ev.event,
      side: ev.side ?? null,
      venue: ev.venue,
      symbol: ev.symbol || this.symbol,
      ts: ev.ts,
      recvTs: ev.recvTs || Date.now(),
      price: ev.price ?? null,
      details: ev.details || {},
      reliability: {
        lagMs: ev.lagMs ?? null,
        depthMode: ev.depthMode ?? (this.books.get(ev.venue)?.depthMode ?? null),
        stale: this.books.get(ev.venue)?.stale ?? false,
      },
    };
    this.stats.total += 1;
    this.stats.byType[full.event] = (this.stats.byType[full.event] || 0) + 1;
    this.onEvent(full);
  }

  // ---- BOOK_TILT (histerezisli) ----
  _checkTilt(book, msg) {
    const bc = this.cfg.events.book;
    const I = book.imbalanceTop(bc.tiltLevels);
    const cur = this.tiltState.get(msg.venue);
    let next = cur;
    if (cur === 'flat') {
      if (I >= bc.tiltEnter) next = 'bid';
      else if (I <= -bc.tiltEnter) next = 'ask';
    } else if (cur === 'bid' && I < bc.tiltExit) next = 'flat';
    else if (cur === 'ask' && I > -bc.tiltExit) next = 'flat';
    if (next !== cur) {
      this.tiltState.set(msg.venue, next);
      if (next !== 'flat') {
        this._out({ event: 'BOOK_TILT', side: next === 'bid' ? 'bid' : 'ask', venue: msg.venue, symbol: this.symbol, ts: msg.exchTs, recvTs: msg.recvTs, price: book.mid(), details: { imbalance: Number(I.toFixed(4)), levels: bc.tiltLevels, entered: true } });
      }
    }
    // MICRO_FLIP: kısa pencerede dengesizlik işaretinin iki yönlü değişimi
    const signs = this.lastTiltSign.get(msg.venue);
    const sign = I > bc.tiltEnter ? 1 : I < -bc.tiltEnter ? -1 : 0;
    if (sign !== 0) {
      const lastSign = signs.length ? signs[signs.length - 1] : null;
      if (lastSign && lastSign.sign !== 0 && lastSign.sign !== sign && msg.exchTs - lastSign.ts <= bc.flipWindowMs) {
        if (this._retriggerOk('MICRO_FLIP', null, msg.venue, msg.exchTs)) {
          this._out({ event: 'MICRO_FLIP', side: sign > 0 ? 'bid' : 'ask', venue: msg.venue, symbol: this.symbol, ts: msg.exchTs, recvTs: msg.recvTs, price: book.mid(), details: { fromSign: lastSign.sign, toSign: sign, windowMs: bc.flipWindowMs, imbalance: Number(I.toFixed(4)) } });
        }
      }
      signs.push({ ts: msg.exchTs, sign });
      while (signs.length && signs[0].ts < msg.exchTs - bc.flipWindowMs * 2) signs.shift();
    }
  }

  // ---- VOID_OPEN: top-N taraf notional'ının hızlı çöküşü (fiyat geçmeden) ----
  _checkVoid(book, msg) {
    const bc = this.cfg.events.book;
    const st = this.voidState.get(msg.venue);
    for (const side of ['bid', 'ask']) {
      const cur = book.sideNotional(side, bc.tiltLevels);
      const s = st[side];
      if (!s.armed) {
        if (cur > 0) { s.armed = true; s.baselineNotional = cur; s.baselineTs = msg.exchTs; }
        continue;
      }
      // Taban yavaşça tazelenir (2 sn'den eskiyse)
      if (msg.exchTs - s.baselineTs >= bc.voidWindowMs) { s.baselineNotional = Math.max(cur, s.baselineNotional * 0.98); s.baselineTs = msg.exchTs; }
      if (s.baselineNotional > 0 && cur < bc.voidDropFactor * s.baselineNotional && msg.exchTs - s.baselineTs <= bc.voidWindowMs) {
        if (!s.dropTs) s.dropTs = msg.exchTs;
        if (msg.exchTs - s.dropTs >= bc.voidPersistMs && msg.exchTs - s.lastEmit >= bc.voidRefractoryMs) {
          s.lastEmit = msg.exchTs;
          this._out({ event: 'VOID_OPEN', side, venue: msg.venue, symbol: this.symbol, ts: msg.exchTs, recvTs: msg.recvTs, price: book.mid(), details: { baselineNotional: Math.round(s.baselineNotional), currentNotional: Math.round(cur), dropRatio: Number((cur / s.baselineNotional).toFixed(3)), levels: bc.tiltLevels } });
          s.armed = false; s.dropTs = 0;   // yeniden silahlan
        }
      } else if (cur >= s.baselineNotional) {
        s.dropTs = 0;
        s.baselineNotional = cur; s.baselineTs = msg.exchTs;
      }
    }
  }

  // ---- SWEEP_REJECT: kısa ekstrem süpürme + geri dönüş ----
  _checkSweep(trade) {
    const sc = this.cfg.events.sweep;
    const st = this.sweepState.get(trade.venue);
    const ts = trade.exchTs || trade.recvTs;
    st.trades.push({ ts, price: trade.price });
    const cutoff = ts - sc.lookbackMs;
    while (st.trades.length && st.trades[0].ts < cutoff) st.trades.shift();

    // Referans: bu işlemden ÖNCEKİ pencere ekstremi (veri sızıntısız)
    const prior = st.trades.slice(0, -1).map((t) => t.price);
    if (prior.length >= 5) {
      const priorHigh = Math.max(...prior), priorLow = Math.min(...prior);
      const sweepBpsUp = ((trade.price - priorHigh) / priorHigh) * 10_000;
      const sweepBpsDown = ((priorLow - trade.price) / priorLow) * 10_000;
      if (sweepBpsUp >= sc.minSweepBps) { st.refHigh = priorHigh; st.sweepHighTs = ts; }
      if (sweepBpsDown >= sc.minSweepBps) { st.refLow = priorLow; st.sweepLowTs = ts; }
    }
    // Geri dönüşler
    if (st.refHigh !== null && ts > st.sweepHighTs && ts - st.sweepHighTs <= sc.rejectMaxMs && trade.price < st.refHigh) {
      if (this._retriggerOk('SWEEP_REJECT', 'ask', trade.venue, ts)) {
        this._out({ event: 'SWEEP_REJECT', side: 'ask', venue: trade.venue, symbol: this.symbol, ts, recvTs: Date.now(), price: trade.price, details: { sweptAbove: st.refHigh, sweepTs: st.sweepHighTs, returnMs: ts - st.sweepHighTs, note: 'yukarı_süpürme_geri_döndü' } });
      }
      st.refHigh = null;
    }
    if (st.refLow !== null && ts > st.sweepLowTs && ts - st.sweepLowTs <= sc.rejectMaxMs && trade.price > st.refLow) {
      if (this._retriggerOk('SWEEP_REJECT', 'bid', trade.venue, ts)) {
        this._out({ event: 'SWEEP_REJECT', side: 'bid', venue: trade.venue, symbol: this.symbol, ts, recvTs: Date.now(), price: trade.price, details: { sweptBelow: st.refLow, sweepTs: st.sweepLowTs, returnMs: ts - st.sweepLowTs, note: 'aşağı_süpürme_geri_döndü' } });
      }
      st.refLow = null;
    }
  }

  /** Dizilim motorunun işlem aralığı metrikleri için. */
  flowBetween(t1, t2) {
    const agg = { count: 0, volume: 0 };
    for (const f of this.flowTrackers.values()) {
      const r = f.between(t1, t2);
      agg.count += r.count; agg.volume += r.volume;
    }
    return agg;
  }

  snapshot() {
    const venues = [];
    for (const [venue, book] of this.books) {
      venues.push({
        venue, book: book.snapshot(),
        walls: this.wallTrackers.get(venue).activeWalls().slice(0, 6),
        flow: this.flowTrackers.get(venue).status(),
        tilt: this.tiltState.get(venue),
      });
    }
    return { symbol: this.symbol, venues, stats: this.stats, uptimeMs: Date.now() - this.startedAt };
  }
}

module.exports = { EventEncoder };
