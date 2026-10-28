'use strict';
/*
 * Market DNA V1 — Olay dizilimi ve motif motoru (spec §4, §6, §7).
 * - Ham olayları tekrarlı durumlardan arındırıp sıralı dizilimlere çevirir.
 * - Pencere içinde n-gram motif keşfi yapar (DISCOVERY).
 * - Keşfedilmiş motifin canlı tetiklenmesinde episod kaydı açar (spec §6'daki alanlarla).
 * - Çoklu ufuklarda üç durumlu sonuç etiketleme (FLAT bandı formülü açık).
 * - Örtüşen sonuç pencerelerini kaydeder (analiz learner'da).
 * - Veri boşluğunda (<RESET>/<SESSION_GAP>) dizilimler birleştirilmez.
 */
const { makeId, median, stdev } = require('../util');

class SequenceEngine {
  constructor(symbol, cfg, hooks) {
    this.symbol = symbol;
    this.cfg = cfg;                       // motifs + outcomes
    this.hooks = hooks || {};             // {makePredictions(ep), onEpisode(ep), onEpisodeResolved(ep), onMotif(motif), onDiscovery(motif)}
    this.events = [];                     // pencere içindeki DNA olayları
    this.resetMarks = [];                 // <RESET>/<SESSION_GAP> zamanları (dizilim kesme + bütünlük)
    this.motifs = new Map();              // motifId → motif kaydı
    this.episodes = [];                   // aktif + çözülmüş episodlar (oturum)
    this.priceHistory = [];               // {ts, price} birincil kaynak
    this.spreadHistory = [];              // {ts, bps}
    this._lastMineAt = 0;
    this._lastTickAt = 0;
    this._seqKeyDeDup = cfg.deDupMs;
  }

  // ---- veri girişi ----
  feedEvent(ev) {
    if (ev.event === '<RESET>' || ev.event === '<SESSION_GAP>') {
      this.resetMarks.push({ ts: ev.ts, event: ev.event });
      this.events.push({ ...ev, _marker: true });
      // Veri kopuğu: dizilim bütünlüğü için pencereyi buradan kes (birleştirme YOK)
      this.events = this.events.filter((e) => e.ts >= ev.ts || e._marker);
      return;
    }
    this.events.push(ev);
    const cutoff = ev.ts - this.cfg.windowMs;
    while (this.events.length && this.events[0].ts < cutoff) this.events.shift();
    while (this.resetMarks.length && this.resetMarks[0].ts < cutoff) this.resetMarks.shift();
    this._checkLiveOccurrence(ev);
    this._maybeMine(ev.ts);
  }

  setPrice(ts, price, spreadBps) {
    if (!Number.isFinite(price)) return;
    this.priceHistory.push({ ts, price });
    const cutoff = ts - 15 * 60_000;
    while (this.priceHistory.length && this.priceHistory[0].ts < cutoff) this.priceHistory.shift();
    if (Number.isFinite(spreadBps)) {
      this.spreadHistory.push({ ts, bps: spreadBps });
      while (this.spreadHistory.length && this.spreadHistory[0].ts < cutoff) this.spreadHistory.shift();
    }
  }

  priceAt(ts, maxSlackMs = 3000) {
    // ts'e en yakın (≤ maxSlack) fiyat; yoksa null
    let best = null;
    for (let i = this.priceHistory.length - 1; i >= 0; i--) {
      const p = this.priceHistory[i];
      if (p.ts <= ts && ts - p.ts <= maxSlackMs) { best = p; break; }
      if (p.ts < ts - maxSlackMs) break;
    }
    return best ? best.price : null;
  }

  /** t0'da bilinen veriyle 1s getiri volatilitesi (bps). Sızıntısız: yalnız ts öncesi örnekler. */
  volBps(ts) {
    const arr = this.priceHistory.filter((p) => p.ts <= ts);
    if (arr.length < 30) return null;
    const rets = [];
    const start = ts - this.cfg.volLookbackMs;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].ts < start) continue;
      const dtS = (arr[i].ts - arr[i - 1].ts) / 1000;
      if (dtS <= 0 || dtS > 5) continue;
      rets.push(((arr[i].price - arr[i - 1].price) / arr[i - 1].price) * 10_000 / Math.sqrt(dtS));
    }
    if (rets.length < 20) return null;
    return stdev(rets);
  }

  medianSpreadBps(ts) {
    const arr = this.spreadHistory.filter((p) => p.ts <= ts && p.ts > ts - 60_000);
    if (arr.length < 5) return null;
    return median(arr.map((p) => p.bps));
  }

  regimeAt(ts) {
    const vol = this.volBps(ts);
    if (vol === null) return { regime: 'warmup', volBps: null };
    // Oturum medyan volatilitesine göre 3 rejim (basit, şeffaf)
    const vols = [];
    for (let t = ts - this.cfg.volLookbackMs; t <= ts; t += 30_000) {
      const v = this.volBps(t);
      if (v !== null) vols.push(v);
    }
    const med = vols.length ? median(vols) : vol;
    const regime = vol > 2 * med ? 'volatile' : vol < 0.5 * med ? 'calm' : 'normal';
    return { regime, volBps: vol };
  }

  hadResetBetween(t1, t2) {
    return this.resetMarks.some((r) => r.ts > t1 && r.ts <= t2);
  }

  // ---- tekrarlı durum filtresi ----
  _dedupedChain(events) {
    const out = [];
    for (const e of events) {
      const prev = out[out.length - 1];
      if (prev && prev.event === e.event && prev.side === e.side && e.ts - prev.ts < this._seqKeyDeDup) continue;
      out.push(e);
    }
    return out;
  }

  // ---- motif keşfi (pencere içi n-gram, gap kısıtlı) ----
  _maybeMine(ts) {
    if (ts - this._lastMineAt < this.cfg.mineEveryMs) return;
    this._lastMineAt = ts;
    const chain = this._dedupedChain(this.events.filter((e) => !e._marker));
    const counts = new Map();   // key → son tamamlanma ts listesi
    for (let n = 2; n <= this.cfg.maxLen; n++) {
      for (let i = n - 1; i < chain.length; i++) {
        let ok = true;
        // Segment içi ardışık boşluk denetimi: k, segmentin ikinci elemanından başlar (chain[-1] yok)
        for (let k = i - n + 2; k <= i; k++) {
          if (chain[k].ts - chain[k - 1].ts > this.cfg.maxGapMs) { ok = false; break; }
        }
        if (!ok) continue;
        const key = chain.slice(i - n + 1, i + 1).map((e) => e.event + (e.side ? ':' + e.side : '')).join('→');
        if (!counts.has(key)) counts.set(key, []);
        counts.get(key).push(chain[i].ts);
      }
    }
    for (const [key, occ] of counts) {
      if (occ.length < this.cfg.minCountDiscovery) continue;
      if (this.motifs.has(key)) continue;
      const motif = {
        motifId: 'm-' + Buffer.from(key).toString('base64url').slice(0, 16),
        chain: key.split('→'),
        key,
        discoveredAt: ts,
        windowCount: occ.length,
        state: 'DISCOVERY',
        episodesTotal: 0,
        occurrences: occ.slice(-this.cfg.maxOccurrencesKept),
      };
      this.motifs.set(key, motif);
      if (this.hooks.onDiscovery) this.hooks.onDiscovery(motif);
      if (this.hooks.onMotif) this.hooks.onMotif(motif);
    }
    // pencere dışına düşen motif görülme sayıları tazelenir
    for (const [key, motif] of this.motifs) {
      const occ = (counts.get(key) || motif.occurrences || []).filter((t) => t >= ts - this.cfg.windowMs);
      motif.windowCount = occ.length;
      motif.occurrences = occ.slice(-this.cfg.maxOccurrencesKept);
    }
  }

  // ---- canlı tetiklenme → episod ----
  _checkLiveOccurrence(ev) {
    const chain = this._dedupedChain(this.events.filter((e) => !e._marker));
    if (chain.length < 2 || chain[chain.length - 1].ts !== ev.ts) return;
    for (let n = Math.min(this.cfg.maxLen, chain.length); n >= 2; n--) {
      const seg = chain.slice(chain.length - n);
      let ok = true;
      for (let k = 1; k < seg.length; k++) if (seg[k].ts - seg[k - 1].ts > this.cfg.maxGapMs) { ok = false; break; }
      if (!ok) continue;
      const key = seg.map((e) => e.event + (e.side ? ':' + e.side : '')).join('→');
      const motif = this.motifs.get(key);
      if (!motif) continue;
      this._createEpisode(motif, seg);
      break; // en uzun eşleşme bir episod açar
    }
  }

  _createEpisode(motif, seg) {
    const t0 = seg[seg.length - 1].ts;
    const { regime, volBps } = this.regimeAt(t0);
    const refPrice = this.priceAt(t0, 2000);
    if (refPrice === null) return;   // referans fiyat yoksa episod açılmaz (veri bütünlüğü)
    const medSpread = this.medianSpreadBps(t0);
    const chain = [];
    let prevTs = null;
    for (const e of seg) {
      const fl = this.flowBetween(prevTs ?? e.ts - 1, e.ts);
      chain.push({
        event: e.event, side: e.side, venue: e.venue, ts: e.ts,
        durFromPrevMs: prevTs === null ? 0 : e.ts - prevTs,
        tradesBetween: fl.count, volumeBetween: Math.round(fl.volume),
      });
      prevTs = e.ts;
    }
    const horizons = {};
    for (const H of this.cfg.horizonsSec) {
      const volTerm = volBps !== null ? volBps * Math.sqrt(H) : null;
      const spreadTerm = medSpread !== null ? this.cfg.spreadMult * medSpread : null;
      const bandBps = Math.max(
        volTerm ?? 0, spreadTerm ?? 0, this.cfg.minBandBps,
      );
      horizons[H] = { bandBps: Number(bandBps.toFixed(3)), pred: null, outcome: null, moveBps: null, resolvedTs: null };
    }
    const ep = {
      epId: makeId('ep'),
      motifId: motif.motifId, motifKey: motif.key,
      coin: this.symbol,
      venues: [...new Set(seg.map((e) => e.venue))],
      t0,
      refPrice,
      chain,
      regime,
      volBpsAtT0: volBps === null ? null : Number(volBps.toFixed(3)),
      integrity: this.hadResetBetween(t0 - (prevTs - seg[0].ts), t0) ? 'reset_in_window' : 'ok',
      horizons,
      overlaps: [],
      invalidatorsFired: [],
      cancelled: false,
      sessionTag: this.sessionTag || 's',
    };
    // Tahminler t0'da, yalnız o ana kadar bilinen veriyle (walk-forward by construction)
    if (this.hooks.makePredictions) ep.horizonsPred = this.hooks.makePredictions(ep);
    // Örtüşme kaydı (aynı motif, |t0a - t0b| < max ufuk)
    const maxH = Math.max(...this.cfg.horizonsSec) * 1000;
    for (const other of this.episodes) {
      if (other.motifId !== motif.motifId) continue;
      if (Math.abs(other.t0 - t0) < maxH) {
        ep.overlaps.push(other.epId);
        other.overlaps.push(ep.epId);
      }
    }
    this.episodes.push(ep);
    if (this.episodes.length > 2000) this.episodes.splice(0, this.episodes.length - 2000);
    motif.episodesTotal += 1;
    if (this.hooks.onEpisode) this.hooks.onEpisode(ep, motif);
    return ep;
  }

  flowBetween(t1, t2) {
    if (this.hooks.flowBetween) return this.hooks.flowBetween(t1, t2);
    return { count: 0, volume: 0 };
  }

  /** Yapısal geçersizlik adayı olayların aktif episodlara kaydı. */
  feedInvalidator(ev) {
    if (!this.cfg.invalidators || !this.cfg.invalidators.includes(ev.event)) return;
    const maxH = Math.max(...this.cfg.horizonsSec) * 1000;
    for (const ep of this.episodes) {
      if (ep.resolvedAll) continue;
      if (ev.ts > ep.t0 && ev.ts <= ep.t0 + maxH) {
        ep.invalidatorsFired.push({ event: ev.event, side: ev.side, ts: ev.ts, venue: ev.venue });
      }
    }
  }

  /** Periyodik çözümleme (1 sn). */
  tick(now) {
    if (now - this._lastTickAt < 1000) return;
    this._lastTickAt = now;
    const maxH = Math.max(...this.cfg.horizonsSec) * 1000;
    for (const ep of this.episodes) {
      if (ep.resolvedAll) continue;
      let all = true;
      for (const H of this.cfg.horizonsSec) {
        const h = ep.horizons[H];
        if (h.outcome) continue;
        const target = ep.t0 + H * 1000;
        if (now < target) { all = false; continue; }
        const pH = this.priceAt(target, 5000);
        if (pH === null) {
          h.outcome = 'UNRESOLVED';
          h.integrity = 'price_gap_at_resolution';
          continue;
        }
        const moveBps = ((pH - ep.refPrice) / ep.refPrice) * 10_000;
        h.moveBps = Number(moveBps.toFixed(2));
        h.resolvedTs = target;
        h.outcome = moveBps > h.bandBps ? 'UP' : moveBps < -h.bandBps ? 'DOWN' : 'FLAT';
        h.priceAtH = pH;
      }
      if (Object.values(ep.horizons).every((h) => h.outcome)) {
        ep.resolvedAll = true;
        ep.resolvedAt = now;
        if (this.hooks.onEpisodeResolved) this.hooks.onEpisodeResolved(ep);
      }
    }
  }

  resolvedEpisodes(motifId) {
    return this.episodes.filter((e) => e.motifId === motifId && e.resolvedAll);
  }

  motifList() {
    return [...this.motifs.values()].map((m) => ({
      motifId: m.motifId, key: m.key, chain: m.chain, state: m.state,
      windowCount: m.windowCount, episodesTotal: m.episodesTotal,
      discoveredAt: m.discoveredAt,
    }));
  }

  episodeList(limit = 30) {
    return this.episodes.slice(-limit).map((e) => ({
      epId: e.epId, motifId: e.motifId, motifKey: e.motifKey, t0: e.t0,
      refPrice: e.refPrice, regime: e.regime, integrity: e.integrity,
      chain: e.chain.map((c) => ({ event: c.event, side: c.side, venue: c.venue, durFromPrevMs: c.durFromPrevMs })),
      horizons: Object.fromEntries(Object.entries(e.horizons).map(([H, h]) => [H, { outcome: h.outcome, moveBps: h.moveBps, bandBps: h.bandBps }])),
      overlaps: e.overlaps.length,
      invalidatorsFired: e.invalidatorsFired.map((i) => i.event),
      cancelled: e.cancelled,
    }));
  }
}

module.exports = { SequenceEngine };
