'use strict';
/*
 * Market DNA V1 — Üç durumlu baz modeller (spec §8).
 * P(UP) + P(FLAT) + P(DOWN) = 1.
 * KURAL: Her model yalnızca tahmin anında (t0) bilinebilen, sonucu ÇÖZÜLMÜŞ episodları kullanır
 * (t0e + H ≤ now). Henüz sonucu belli olmayan episodlar EĞİTİME KATILMAZ (veri sızıntısı önleme).
 * Hiçbir model önceden kazanan ilan edilmez; başarım yalnızca ileri veriyle ölçülür.
 */
const { meanOf } = require('./stats');

function uniform() { return { UP: 1 / 3, FLAT: 1 / 3, DOWN: 1 / 3 }; }

function normalize3(up, flat, down) {
  const s = up + flat + down;
  if (s <= 0) return uniform();
  return { UP: up / s, FLAT: flat / s, DOWN: down / s };
}

/** Çözülmüş episodlardan (belirli ufuk) örnek listesi çıkar. */
function samples(resolved, H, now) {
  const out = [];
  for (const ep of resolved) {
    const h = ep.horizons[H];
    if (!h || !h.outcome || h.outcome === 'UNRESOLVED') continue;
    const resolutionTs = ep.t0 + H * 1000;
    if (resolutionTs > now) continue;     // sonuç t0 anında bilinmiyordu → kullanma
    out.push(h.outcome);
  }
  return out;
}

function ratesFrom(list) {
  if (!list.length) return uniform();
  const up = list.filter((x) => x === 'UP').length;
  const flat = list.filter((x) => x === 'FLAT').length;
  const down = list.filter((x) => x === 'DOWN').length;
  // Laplace yumuşatma (küçük örneklemde 0/1 olasılık patlamasını önler)
  return normalize3(up + 1, flat + 1, down + 1);
}

class BaseModelFamily {
  constructor(cfg) {
    this.cfg = cfg;
    this.names = ['M0_fixed', 'M1_short', 'M2_long', 'M3_decomposed'];
    // Her modelin online başarımı (yalnız t0'da verilmiş tahminlerle)
    this.scores = {};   // name → [{brier, correct}]
    for (const n of this.names) this.scores[n] = [];
  }

  /**
   * t0'da tüm modeller için tahmin üret.
   * resolved: motordan gelen çözülmüş episodlar (tüm motifler, oturum + hafıza birleşik).
   */
  predictAll(resolved, now) {
    const preds = {};
    for (const H of this.cfg.horizonsSec) {
      const listAll = samples(resolved, H, now);
      const tShort = now - 5 * 60_000;
      const listShort = listAll.filter((_, i) => false); // yer tutucu; aşağıda t0 filtresiyle
      // Not: samples() t0 bilgisi taşımıyor; t0 filtresi için resolved üzerinden yeniden örnekle
      const pick = (fromMs, toMs) => {
        const out = [];
        for (const ep of resolved) {
          const h = ep.horizons[H];
          if (!h || !h.outcome || h.outcome === 'UNRESOLVED') continue;
          if (ep.t0 + H * 1000 > now) continue;
          if (ep.t0 < fromMs || ep.t0 > toMs) continue;
          out.push(h.outcome);
        }
        return out;
      };
      void listShort;
      const shortList = pick(now - 5 * 60_000, now);
      const longList = pick(now - 60 * 60_000, now);
      const fixedList = pick(-Infinity, now);        // M0: oturum başından (sabit dönem: oturum + hafıza)
      const m1 = ratesFrom(shortList);
      const m2 = ratesFrom(longList);
      const m0 = ratesFrom(fixedList);
      // M3 ayrıştırılmış: hızlı P(FLAT) kısa pencereden; P(UP|MOVE) uzun pencereden
      const moveShort = shortList.filter((x) => x !== 'FLAT');
      const upGivenMove = moveShort.length ? moveShort.filter((x) => x === 'UP').length / moveShort.length : 0.5;
      const pFlat = m1.FLAT;
      const m3 = normalize3((1 - pFlat) * upGivenMove, pFlat, (1 - pFlat) * (1 - upGivenMove));
      preds[H] = { M0_fixed: m0, M1_short: m1, M2_long: m2, M3_decomposed: m3 };
    }
    return preds;
  }

  /** Çözüm sonrası online skorlama (walk-forward: tahmin t0'da verilmişti). */
  score(predsByHorizon, ep) {
    for (const H of this.cfg.horizonsSec) {
      const h = ep.horizons[H];
      if (!h || !h.outcome || h.outcome === 'UNRESOLVED') continue;
      const preds = predsByHorizon?.[H];
      if (!preds) continue;
      for (const name of this.names) {
        const p = preds[name];
        if (!p) continue;
        const { brierMulti } = require('./stats');
        this.scores[name].push({ brier: brierMulti(p, h.outcome), correct: h.outcome === 'UP' || h.outcome === 'DOWN' ? (p[h.outcome] > p[otherOf(h.outcome)]) : null, outcome: h.outcome });
      }
    }
    function otherOf(o) { return o === 'UP' ? 'DOWN' : 'UP'; }
  }

  meanBrier(name, window) {
    const arr = this.scores[name];
    const w = window ? arr.slice(-window) : arr;
    return w.length ? meanOf(w.map((x) => x.brier)) : null;
  }

  snapshot() {
    const out = {};
    for (const n of this.names) {
      out[n] = { n: this.scores[n].length, meanBrier: this.meanBrier(n), meanBrierRecent: this.meanBrier(n, 30) };
    }
    return out;
  }
}

module.exports = { BaseModelFamily, ratesFrom, samples, uniform };
