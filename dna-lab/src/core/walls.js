'use strict';
/*
 * Market DNA V1 — Duvar izleyici (WALL_SPAWN / WALL_TEST / WALL_HOLD / WALL_PULL / WALL_BREAK).
 *
 * ÖNEMLİ (spec §3): WALL_PULL yalnızca GÖZLENEN likidite çekilmesidir; otomatik
 * manipülasyon/spoofing kanıtı SAYILMAZ. Olaylara başlangıçta yön anlamı yüklenmez.
 *
 * Duvar tanımı: notional(P) >= max(absFloor, kMedian × medyan(seviye notional'ları)).
 * Bu bir gözlemsel koşuldur; eşiğin kendisi araştırma parametresidir (config.events.walls).
 */
const { bpsOf } = require('../util');

class WallTracker {
  constructor(venue, symbol, cfg, emitEvent) {
    this.venue = venue;
    this.symbol = symbol;
    this.cfg = cfg;            // config.events.walls
    this.emitEvent = emitEvent;
    /** key: side|price → wall objesi */
    this.walls = new Map();
    /** key → son SPAWN zamanı (cooldown) */
    this.lastSpawnAt = new Map();
    /** key → aday seviyenin eşiği ilk aştığı zaman (spawnPersistMs filtresi) */
    this.candidates = new Map();
    this.lastTrade = { price: null, ts: 0, side: null };
  }

  _key(side, price) { return side + '|' + price; }

  onTrade(trade) {
    this.lastTrade = { price: trade.price, ts: trade.exchTs || trade.recvTs, side: trade.side };
    // Duvar kırılma denetimi: agresif işlem duvar fiyatını geçti mi?
    for (const [key, w] of this.walls) {
      if (w.state === 'broken') continue;
      if (w.side === 'bid' && this.lastTrade.price < w.price - Number.EPSILON) {
        this._break(w, this.lastTrade.ts, { throughPrice: this.lastTrade.price, tradeNotional: trade.price * trade.qty });
      } else if (w.side === 'ask' && this.lastTrade.price > w.price + Number.EPSILON) {
        this._break(w, this.lastTrade.ts, { throughPrice: this.lastTrade.price, tradeNotional: trade.price * trade.qty });
      }
    }
  }

  onBook(book, msg) {
    const cfg = this.cfg;
    const ts = msg.exchTs || msg.recvTs;
    const exchTs = msg.exchTs || ts;

    for (const side of ['bid', 'ask']) {
      const arr = side === 'bid' ? book.bids : book.asks;
      const med = book.medianLevelNotional(side, cfg.searchLevels);
      const enterThresh = Math.max(cfg.absFloorNotional, cfg.kMedian * med);

      // 1) Mevcut duvarları güncelle
      for (const [key, w] of [...this.walls]) {
        if (w.side !== side) continue;
        const cur = book.levelNotional(side, w.price);
        w.lastSeenTs = ts;
        w.notional = cur;

        if (w.state !== 'broken' && cur < cfg.goneFactor * enterThresh) {
          if (w.brokenByTrade) continue; // onTrade zaten BREAK üretti
          // Fiyat duvarı geçmediyse ve likidite çekildiyse → PULL (gözlemsel)
          // Kararlılık: çok genç duvar sessizce silinir (spawn→pull gürültüsü önlenir)
          this._pull(w, ts, cur, enterThresh, true);
          this.walls.delete(key);
          continue;
        }
        if (w.state !== 'pulled' && w.state !== 'broken' && cur < cfg.pullFactor * w.peakNotional && cur >= cfg.goneFactor * enterThresh) {
          this._pull(w, ts, cur, enterThresh, false);
        }
        // Test durumu
        const tested = this._isTested(w);
        if (tested && !w.tested) {
          w.tested = true;
          w.testStartTs = ts;
          this._emit('WALL_TEST', w, ts, { notional: cur, enterThresh });
        } else if (!tested && w.tested) {
          w.tested = false;
          w.testStartTs = null;
        }
        if (w.tested && w.state === 'active' && w.testStartTs && ts - w.testStartTs >= cfg.holdMs && cur >= cfg.goneFactor * enterThresh) {
          w.state = 'held';
          this._emit('WALL_HOLD', w, ts, { notional: cur, holdMs: ts - w.testStartTs, enterThresh });
        }
        if (cur > w.peakNotional) w.peakNotional = cur;
      }

      // 2) Yeni duvar adayları (kararlılık filtresi: eşik üstü kalıcılık)
      const candidateKeys = new Set();
      for (const [p, q] of arr.slice(0, cfg.searchLevels)) {
        const notional = p * q;
        if (notional < enterThresh) continue;
        const key = this._key(side, p);
        candidateKeys.add(key);
        if (this.walls.has(key)) continue;
        if (!this.candidates.has(key)) this.candidates.set(key, ts);
        if (ts - this.candidates.get(key) < cfg.spawnPersistMs) continue;
        const last = this.lastSpawnAt.get(key) || 0;
        if (ts - last < cfg.respawnCooldownMs) continue;
        const w = {
          side, price: p, venue: this.venue, symbol: this.symbol,
          bornTs: ts, peakNotional: notional, notional,
          tested: false, testStartTs: null, state: 'active', brokenByTrade: false,
          pulledOnce: false,
        };
        this.walls.set(key, w);
        this.lastSpawnAt.set(key, ts);
        this.candidates.delete(key);
        this._emit('WALL_SPAWN', w, ts, { notional, enterThresh, medianLevelNotional: med });
      }
      // eşiğin altına inen adayları temizle (yalnız bu tarafın adayları)
      for (const key of [...this.candidates.keys()]) {
        if (!key.startsWith(side + '|')) continue;
        if (!candidateKeys.has(key)) this.candidates.delete(key);
      }
    }
  }

  _isTested(w) {
    const band = this.cfg.testBandBps;
    const lp = this.lastTrade.price;
    if (lp === null || !Number.isFinite(lp)) return false;
    const bps = bpsOf(lp, w.price);
    if (w.side === 'bid') return bps <= band && bps >= -band * 3;  // fiyat duvara yukarıdan yaklaştı
    return bps >= -band && bps <= band * 3;                        // fiyat duvara aşağıdan yaklaştı
  }

  _emit(event, w, ts, details) {
    this.emitEvent({
      event, side: w.side, venue: this.venue, symbol: this.symbol,
      ts, recvTs: Date.now(), price: w.price,
      details: {
        wallAgeMs: ts - w.bornTs, peakNotional: w.peakNotional,
        wallState: w.state, ...details,
      },
    });
  }

  _pull(w, ts, cur, enterThresh, vanished) {
    if (w.pulledOnce) return;
    if (ts - w.bornTs < this.cfg.pullMinAgeMs) return;   // genç duvar: sessiz (gürültü önleme)
    w.pulledOnce = true;
    w.state = 'pulled';
    this._emit('WALL_PULL', w, ts, {
      notional: cur, peakNotional: w.peakNotional,
      dropRatio: w.peakNotional > 0 ? cur / w.peakNotional : 0,
      vanished, enterThresh,
      note: 'gozlemsal_likidite_cekilmesi',   // spoofing kanıtı DEĞİL
    });
  }

  _break(w, ts, extra) {
    if (w.state === 'broken') return;
    w.state = 'broken';
    w.brokenByTrade = true;
    this._emit('WALL_BREAK', w, ts, { notional: 0, ...extra });
    this.walls.delete(this._key(w.side, w.price));
  }

  /** Aktif duvarların özeti (UI ve episodlar için). */
  activeWalls() {
    return [...this.walls.values()].filter((w) => w.state !== 'broken').map((w) => ({
      side: w.side, price: w.price, notional: w.notional, peakNotional: w.peakNotional,
      state: w.state, ageMs: Date.now() - w.bornTs, tested: w.tested,
    }));
  }
}

module.exports = { WallTracker };
