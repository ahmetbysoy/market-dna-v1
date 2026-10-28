'use strict';
/*
 * Market DNA V1 — İşlem akışı izleyici (FLOW_BURST / FLOW_EXHAUST).
 * Saniye kovalarında agresif işlem notional'ı tutar; taban çizgisi istatistiği ve
 * histerezisli burst/exhaust durum makinesi işletir.
 */
const { mean, stdev } = require('../util');

class TradeFlowTracker {
  constructor(venue, symbol, cfg, emitEvent) {
    this.venue = venue;
    this.symbol = symbol;
    this.cfg = cfg;               // config.events.flow
    this.emitEvent = emitEvent;
    this.buckets = [];            // {sec, buy, sell, count, volume}
    this.burstState = { buy: null, sell: null };   // {startTs, peakNotional, lastActiveTs}
    this.lastBurstAt = { buy: 0, sell: 0 };
    this.lastExhaustAt = { buy: 0, sell: 0 };
    this.trades = [];             // son pencere (histerezis için)
  }

  onTrade(trade) {
    const ts = trade.exchTs || trade.recvTs;
    const sec = Math.floor(ts / 1000);
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.sec !== sec) {
      b = { sec, buy: 0, sell: 0, count: 0, volume: 0 };
      this.buckets.push(b);
      const cutoff = sec - Math.ceil((this.cfg.baselineWindowMs + this.cfg.exhaustSearchMs) / 1000) - 2;
      while (this.buckets.length && this.buckets[0].sec < cutoff) this.buckets.shift();
    }
    const n = trade.price * trade.qty;
    if (trade.side === 'buy') b.buy += n; else b.sell += n;
    b.count += 1; b.volume += n;
    this.trades.push({ ts, price: trade.price, qty: trade.qty, side: trade.side, notional: n });
    const cutoffMs = ts - (this.cfg.baselineWindowMs + this.cfg.exhaustSearchMs);
    while (this.trades.length && this.trades[0].ts < cutoffMs) this.trades.shift();
    this._maybeBurst(ts, trade.side, n);
  }

  _maybeBurst(ts, side, lastNotional) {
    const cfg = this.cfg;
    // Saniye kovası henüz yarım olabilir; burst tespiti anlık pencereyle yapılır.
    const wStart = ts - cfg.burstWindowMs;
    const inWindow = this.trades.filter((t) => t.ts >= wStart && t.side === side);
    const notional1s = inWindow.reduce((a, t) => a + t.notional, 0);

    // Taban: son baselineWindow içindeki tam saniye kovalarının toplam notional'ı
    const secNow = Math.floor(ts / 1000);
    const base = this.buckets.filter((b) => b.sec < secNow && b.sec >= secNow - cfg.baselineWindowMs / 1000);
    if (base.length < cfg.baselineMinSamples) return;
    const series = base.map((b) => b.buy + b.sell);
    const mu = mean(series), sd = stdev(series);

    const state = this.burstState[side];
    if (!state) {
      // Sabit tabanda sd=0 olabilir: z tanımsızsa mutlak üstünlük eşikle birlikte kullanılır
      const z = sd > 0 ? (notional1s - mu) / sd : (notional1s > mu ? cfg.zEnter + 1 : 0);
      if (z >= cfg.zEnter && notional1s >= cfg.absFloorNotional && ts - this.lastBurstAt[side] >= cfg.refractoryMs) {
        this.burstState[side] = { startTs: ts, peakNotional: notional1s, lastActiveTs: ts };
        this.lastBurstAt[side] = ts;
        this._emit('FLOW_BURST', side, ts, { notionalWindow: Math.round(notional1s), z: Number(z.toFixed(2)), baselineMean: Math.round(mu), baselineSd: Math.round(sd), tradeCount: inWindow.length });
      }
    } else {
      if (notional1s > state.peakNotional) state.peakNotional = notional1s;
      if (notional1s >= mu) state.lastActiveTs = ts;   // hâlâ tabanın üstünde: burst sürüyor
      else if (ts - state.lastActiveTs >= cfg.exhaustMinMs && ts - state.startTs <= cfg.exhaustSearchMs + cfg.burstWindowMs) {
        this._emit('FLOW_EXHAUST', side, ts, { burstDurationMs: ts - state.startTs, peakNotional: Math.round(state.peakNotional), baselineMean: Math.round(mu) });
        this.burstState[side] = null;
        this.lastExhaustAt[side] = ts;
      } else if (ts - state.startTs > cfg.exhaustSearchMs + cfg.burstWindowMs) {
        // Pencere dışına çıktı, sessiz kapat
        this.burstState[side] = null;
      }
    }
  }

  _emit(event, side, ts, details) {
    this.emitEvent({ event, side, venue: this.venue, symbol: this.symbol, ts, recvTs: Date.now(), price: null, details });
  }

  /** (t1,t2] aralığındaki işlem sayısı ve notional (tüm taraflar) — episodlar için. */
  between(t1, t2) {
    let count = 0, volume = 0;
    for (const t of this.trades) {
      if (t.ts > t1 && t.ts <= t2) { count += 1; volume += t.notional; }
    }
    return { count, volume };
  }

  status() {
    const active = [];
    for (const side of ['buy', 'sell']) if (this.burstState[side]) active.push(side);
    return { venue: this.venue, tradesBuffered: this.trades.length, activeBursts: active };
  }
}

module.exports = { TradeFlowTracker };
