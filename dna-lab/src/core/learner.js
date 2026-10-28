'use strict';
/*
 * Market DNA V1 — Karantinalı öğrenme sistemi (spec §5, §11) ve yaşam döngüsü.
 *
 * DISCOVERY → INCUBATION → VALIDATION → GRADUATED
 *                                ↘ QUARANTINED (geri dönebilir) / RETIRED
 *
 * Mezuniyet yalnızca isabet oranına DAYANMAZ; birlikte değerlendirilir:
 *   - etkin örneklem (örtüşme kümeleme + seri bağımlılık — ADAY formüller),
 *   - en iyi baz modele göre Brier iyileşmesi (eşleştirilmiş, küme-bootstrap CI),
 *   - kalibrasyon (ECE),
 *   - rejim tutarlılığı,
 *   - çoklu hipotez düzeltmesi (BH-FDR, motif ailesi üzerinden),
 *   - veri bütünlüğü.
 * Veri yetersizse motif KULUÇKADA kalır — bu DOĞRU davranıştır (spec §16).
 */
const { brierMulti, ece, effectiveN, pairedBootstrapCluster, benjaminiHochberg, meanOf } = require('./stats');
const { ewma } = require('../util');

class Learner {
  constructor(symbol, cfg, hooks) {
    this.symbol = symbol;
    this.cfg = cfg;                     // config.learner
    this.hooks = hooks || {};           // {onMotifUpdate(motif, info), onGraduated(motif), onQuarantined(motif, reason), onInvalidation(ep, motif)}
    /** motifId → learner kaydı */
    this.motifs = new Map();
    /** baz model ailesi (oturum içi) */
    this.base = null;
    /** hafıza ile birleşik çözülmüş episod havuzu (baz model eğitim havuzu) */
    this.resolvedPool = [];
    this.graduatedCount = 0;
    this.sessionStart = Date.now();
  }

  attachBase(base) { this.base = base; }

  ensure(motif) {
    let m = this.motifs.get(motif.motifId);
    if (!m) {
      m = {
        motifId: motif.motifId, key: motif.key, chain: motif.chain,
        state: 'INCUBATION',            // DISCOVERY'den hemen sonra kuluçka: sonuç gözlemi başlar
        discoveredAt: motif.discoveredAt,
        episodes: [],                   // çözülmüş episodlar (motifin kendi)
        pending: [],
        lastEvalAt: 0,
        metrics: null,
        quarantineReason: null,
        invalidators: {},               // event → {withOutcomeWrong, withOutcomeTotal, withoutWrong, withoutTotal}
        cancelStats: { caughtFalse: 0, cancelledGood: 0 },
        decayWeight: 1,
        lastEpisodeAt: 0,
        evalLog: [],
      };
      this.motifs.set(motif.motifId, m);
    }
    return m;
  }

  /** Motordan yeni episod. Tahmin kaydı learner'da tutulur. */
  onEpisode(ep, motif) {
    const m = this.ensure(motif);
    m.lastEpisodeAt = ep.t0;
    if (m.state === 'RETIRED') {
      // bayatlamış motif yeniden canlanırsa kuluçkaya döner
      m.state = 'INCUBATION';
      m.decayWeight = 1;
    }
  }

  /** Epizod çözüldü → motif modeli skorla, yaşam döngüsünü değerlendir. */
  onEpisodeResolved(ep) {
    const m = this.motifs.get(ep.motifId);
    if (!m) return;
    // Baz model havuzuna ekle (tüm motifler birleşik — baz model motif-agnostiktır)
    this.resolvedPool.push(ep);
    m.episodes.push(ep);
    if (m.episodes.length > 500) m.episodes.shift();

    // Baz modellerin online skorlaması (tahminler t0'da verilmişti → walk-forward)
    if (this.base && ep.horizonsPred && ep.horizonsPred.baseModels) {
      this.base.score(ep.horizonsPred.baseModels, ep);
    }

    // Motif gölge modeli: kendi çözülmüş episodlarının üstel yaşlandırmalı dağılımı
    // (yalnız çözümü t0'dan ÖNCE tamamlanmış episodlar zaten tahmine girdi; burada skore ederiz)
    this._scoreMotifModel(ep, m);
    this._evaluate(m);
  }

  _motifPredFor(m, H, now) {
    // Sızıntısız: yalnız çözüm zamanı geçmiş episodlar
    const byH = { UP: 0, FLAT: 0, DOWN: 0 };
    let wsum = 0;
    const halfLifeMs = this.cfg.retireHalfLifeDays * 24 * 3600 * 1000;
    for (const e of m.episodes) {
      const h = e.horizons[H];
      if (!h || !h.outcome || h.outcome === 'UNRESOLVED') continue;
      if (e.t0 + H * 1000 > now) continue;
      const w = Math.pow(0.5, (now - e.t0) / halfLifeMs);   // üstel yaşlandırma ADAYI
      byH[h.outcome] += w; wsum += w;
    }
    if (wsum <= 0) return null;
    return { UP: (byH.UP + 1) / (wsum + 3), FLAT: (byH.FLAT + 1) / (wsum + 3), DOWN: (byH.DOWN + 1) / (wsum + 3) };
  }

  _scoreMotifModel(ep, m) {
    // Epizodun t0'ında motif modeli tahmini verilmiş mi? (hooks.makePredictions içinde verildi)
    const preds = ep.horizonsPred && ep.horizonsPred.motifModel;
    if (!preds) return;
    m.predHistory = m.predHistory || [];
    m.predHistory.push({ epId: ep.epId, t0: ep.t0, preds, outcomes: Object.fromEntries(Object.entries(ep.horizons).map(([H, h]) => [H, h.outcome])) });
    if (m.predHistory.length > 500) m.predHistory.shift();
  }

  /** Yaşam döngüsü değerlendirmesi (VALIDATION bloğu + mezuniyet/karantina). */
  _evaluate(m) {
    const cfg = this.cfg;
    const now = Date.now();
    if (now - m.lastEvalAt < 5_000) return;   // değerlendirme gecikmesi (spam önleme)
    m.lastEvalAt = now;

    const resolved = m.episodes;
    const inc = cfg.incubationMinEpisodes;
    if (m.state === 'INCUBATION' && resolved.length >= inc) {
      m.state = 'VALIDATION';
    }
    if (m.state !== 'VALIDATION' && m.state !== 'GRADUATED' && m.state !== 'QUARANTINED') return;
    if (resolved.length < Math.max(5, cfg.validationForwardBlock)) return;

    // ---- metrikler: en iyi baz model karşılaştırması (ufuk başına ayrı, en iyi ufuk raporlanır) ----
    const windowMs = 120_000;   // sonuç penceresi üst sınırı + pay
    const perHorizon = [];
    for (const H of Object.keys(resolved[0].horizons).map(Number)) {
      const items = [];
      for (const ep of resolved) {
        const h = ep.horizons[H];
        if (!h || !h.outcome || h.outcome === 'UNRESOLVED') continue;
        const hp = ep.horizonsPred;
        const motifP = hp && hp.motifModel && hp.motifModel[H];
        const baseP = hp && hp.baseModels && hp.baseModels[H];
        if (!motifP || !baseP) continue;
        // en iyi baz model: tahmin anında seçilemez → denetimde hepsi değerlendirilir,
        // karşılaştırma için "en iyi skorlu baz" (yalnız geçmiş verisiyle belirlenir) kullanılır
        const bestBase = this._bestBaseName(baseP);
        const a = brierMulti(motifP, h.outcome);
        const b = brierMulti(baseP[bestBase], h.outcome);
        items.push({ clusterId: this._clusterOf(ep, resolved, windowMs), a, b, epId: ep.epId, outcome: h.outcome, motifP, baseP });
      }
      if (items.length >= 5) {
        const boot = pairedBootstrapCluster(items, cfg.bootstrapResamples, cfg.confidence);
        const neffInfo = effectiveN(items.map((x) => ({ t0: resolved.find((e) => e.epId === x.epId).t0 })), windowMs, items.map((x) => x.outcome === 'FLAT' ? 0 : x.outcome === 'UP' ? 1 : -1));
        const pairs = [];
        for (const it of items) {
          for (const c of ['UP', 'FLAT', 'DOWN']) pairs.push({ p: it.motifP[c], y: it.outcome === c ? 1 : 0 });
        }
        perHorizon.push({ H, brierMotif: meanOf(items.map((x) => x.a)), brierBase: meanOf(items.map((x) => x.b)), ...boot, neffInfo, ece: ece(pairs, 5), items: items.length });
      }
    }
    if (!perHorizon.length) return;
    // En anlamlı ufuk seçimi: en düşük p değeri (ileri veriyle yalnız denetimde)
    perHorizon.sort((x, y) => (x.pValue ?? 1) - (y.pValue ?? 1));
    const best = perHorizon[0];
    const integrityRatio = resolved.filter((e) => e.integrity !== 'ok').length / resolved.length;

    const neff = best.neffInfo ? best.neffInfo.nEff : 0;
    const lift = best.brierBase - best.brierMotif;   // pozitif = motif daha iyi
    m.metrics = {
      horizonSec: best.H,
      episodes: resolved.length,
      nEff, nClusters: best.neffInfo?.nClusters, nSerial: best.neffInfo?.nSerial,
      brierMotif: best.brierMotif, brierBase: best.brierBase,
      lift, ciLow: best.ciLow, ciHigh: best.ciHigh, pValue: best.pValue,
      ece: best.ece, integrityRatio,
      regimeCoverage: this._regimeCoverage(resolved, best.H),
      evaluatedAt: now,
    };

    // ---- çoklu hipotez: ailedeki tüm motiflerin p değerleri üzerinden BH ----
    const ids = [...this.motifs.keys()];
    const pvals = ids.map((id) => this.motifs.get(id).metrics?.pValue ?? null);
    const qs = benjaminiHochberg(pvals);
    m.metrics.qValue = qs[ids.indexOf(m.motifId)];

    // ---- karantina denetimi (GRADUATED/VALIDATION) ----
    const recent = resolved.slice(-cfg.quarantineWindow);
    const recentPreds = recent.filter((e) => e.horizonsPred && e.horizonsPred.motifModel);
    let quarantineReason = null;
    if (integrityRatio > cfg.quarantineIntegrityRatio) quarantineReason = 'veri_butunlugu_dusuk';
    if (recentPreds.length >= 10) {
      const rm = meanOf(recentPreds.map((e) => brierMulti(e.horizonsPred.motifModel[m.metrics.horizonSec], e.horizons[m.metrics.horizonSec].outcome)));
      const rb = meanOf(recentPreds.map((e) => {
        const bp = e.horizonsPred.baseModels[m.metrics.horizonSec];
        return brierMulti(bp[this._bestBaseName(bp)], e.horizons[m.metrics.horizonSec].outcome);
      }));
      if (rm - rb > -cfg.quarantineBrierSlack * -1 && rm > rb + 0.01) quarantineReason = 'yakın_pencerede_baz_modelden_kötü';
    }
    if (quarantineReason && m.state === 'GRADUATED') {
      m.state = 'QUARANTINED';
      m.quarantineReason = quarantineReason;
      if (this.hooks.onQuarantined) this.hooks.onQuarantined(m, quarantineReason);
      return;
    }

    // ---- mezuniyet koşulları ----
    if (m.state === 'VALIDATION' || m.state === 'QUARANTINED') {
      const pass =
        neff >= cfg.nEffMin &&
        lift >= cfg.brierLiftMin &&
        best.ciLow !== null && best.ciLow > 0 &&
        (m.metrics.qValue === null || m.metrics.qValue <= cfg.bhQ) &&
        m.metrics.regimeCoverage >= cfg.minRegimeCoverage &&
        integrityRatio <= cfg.quarantineIntegrityRatio;
      m.evalLog.push({ at: now, pass, neff, lift, ciLow: best.ciLow, q: m.metrics.qValue, coverage: m.metrics.regimeCoverage, n: resolved.length });
      if (m.evalLog.length > 50) m.evalLog.shift();
      if (pass) {
        if (m.state !== 'GRADUATED') {
          m.state = 'GRADUATED';
          m.graduatedAt = now;
          m.graduatedHorizonSec = best.H;
          m.quarantineReason = null;
          this.graduatedCount += 1;
          this._learnInvalidators(m);
          if (this.hooks.onGraduated) this.hooks.onGraduated(m);
        } else {
          m.state = 'GRADUATED';   // karantinadan dönüş
          m.quarantineReason = null;
        }
      } else if (m.state === 'QUARANTINED' && !quarantineReason) {
        m.state = 'VALIDATION';    // koşullar düzelirse doğrulamaya geri
      }
      if (this.hooks.onMotifUpdate) this.hooks.onMotifUpdate(m, { pass });
    }
    this._retireCheck(m, now);
  }

  _clusterOf(ep, resolved, windowMs) {
    // Örtüşme küme kimliği: t0'ları sıralayıp pencere genişliğinde grupla
    const sameMotif = resolved.filter((e) => e.motifId === ep.motifId).map((e) => e.t0).sort((a, b) => a - b);
    let clusterStart = -Infinity, id = 0;
    for (const t0 of sameMotif) {
      if (t0 > clusterStart + windowMs) { id += 1; clusterStart = t0; }
      if (t0 === ep.t0) return id;
    }
    return id;
  }

  _regimeCoverage(resolved, H) {
    // Lift'in rejimlere göre işareti (motif - baz): negatif olmayan lift sayısı
    const byRegime = new Map();
    for (const ep of resolved) {
      const h = ep.horizons[H];
      const hp = ep.horizonsPred;
      if (!h || !h.outcome || h.outcome === 'UNRESOLVED' || !hp || !hp.motifModel || !hp.baseModels) continue;
      const bp = hp.baseModels[H];
      const bb = brierMulti(bp[this._bestBaseName(bp)], h.outcome);
      const bm = brierMulti(hp.motifModel[H], h.outcome);
      if (!byRegime.has(ep.regime)) byRegime.set(ep.regime, []);
      byRegime.get(ep.regime).push(bb - bm);
    }
    let ok = 0, seen = 0;
    for (const [, arr] of byRegime) {
      if (arr.length < 5) continue;
      seen += 1;
      if (meanOf(arr) >= 0) ok += 1;
    }
    return { ok, seen };
  }
  // Yukarıdaki sayısal alan kullanımını sadeleştirmek için sayıya çevir
  _regimeCoverageNum(resolved, H) {
    const r = this._regimeCoverage(resolved, H);
    return r.ok;
  }

  _bestBaseName(basePreds) {
    // Yalnız geçmiş online skorlamaya göre en iyi baz model (t0 anındaki bilgiyle — skorlar çözümle birikir)
    let best = 'M0_fixed', bestB = Infinity;
    for (const name of Object.keys(basePreds)) {
      const b = this.base ? this.base.meanBrier(name) : null;
      if (b !== null && b < bestB) { best = name; bestB = b; }
    }
    return best;
  }

  /** Yapısal geçersizlik öğrenimi (spec §11): hangi olaylar tezi bozuyor? (empirik) */
  _learnInvalidators(m) {
    const cfg = this.cfg;
    const H = m.graduatedHorizonSec;
    for (const inv of cfg.invalidators) {
      const withE = { total: 0, wrong: 0 };
      const without = { total: 0, wrong: 0 };
      for (const ep of m.episodes) {
        const h = ep.horizons[H];
        if (!h || !h.outcome || h.outcome === 'UNRESOLVED') continue;
        const fired = ep.invalidatorsFired.some((i) => i.event === inv);
        // motifin "tezi": tahmin anındaki en yüksek olasılık yönü
        const pred = ep.horizonsPred && ep.horizonsPred.motifModel && ep.horizonsPred.motifModel[H];
        if (!pred) continue;
        const thesis = Object.entries(pred).sort((a, b) => b[1] - a[1])[0][0];
        const wrong = thesis !== h.outcome;
        if (fired) { withE.total += 1; if (wrong) withE.wrong += 1; }
        else { without.total += 1; if (wrong) without.wrong += 1; }
      }
      if (withE.total >= 5 && without.total >= 5) {
        const rWith = withE.wrong / withE.total;
        const rWithout = without.wrong / without.total;
        if (rWith > rWithout) {
          m.invalidators[inv] = { rWith, rWithout, nWith: withE.total, nWithout: without.total, learned: true };
        }
      }
    }
  }

  /** Aktif tahmin için yapısal geçersizlik denetimi (erken iptal). */
  checkInvalidation(ep, motif) {
    const m = this.motifs.get(motif.motifId);
    if (!m || m.state !== 'GRADUATED') return null;
    const learned = Object.keys(m.invalidators).filter((k) => m.invalidators[k].learned);
    const fired = ep.invalidatorsFired.filter((i) => learned.includes(i.event));
    if (!fired.length) return null;
    const first = fired[0];
    if (!ep.cancelled) {
      ep.cancelled = true;
      ep.cancelledBy = first.event;
      ep.cancelledAt = first.ts;
      // Erken iptal değerlendirmesi sonuç çözülünce tamamlanır (caughtFalse vs cancelledGood)
      this.hooks.onInvalidation && this.hooks.onInvalidation(ep, m, first);
    }
    return { event: first.event, at: first.ts, stats: m.cancelStats };
  }

  /** Çözümde iptal değerlendirmesi. */
  evaluateCancellation(ep) {
    const m = this.motifs.get(ep.motifId);
    if (!m || !ep.cancelled) return;
    const H = m.graduatedHorizonSec;
    const h = ep.horizons[H];
    if (!h || !h.outcome || h.outcome === 'UNRESOLVED') return;
    const pred = ep.horizonsPred && ep.horizonsPred.motifModel && ep.horizonsPred.motifModel[H];
    if (!pred) return;
    const thesis = Object.entries(pred).sort((a, b) => b[1] - a[1])[0][0];
    const wasWrong = thesis !== h.outcome;
    if (wasWrong) m.cancelStats.caughtFalse += 1; else m.cancelStats.cancelledGood += 1;
    ep.cancelOutcome = { wasWrong, ...m.cancelStats };
  }

  _retireCheck(m, now) {
    const halfLifeMs = this.cfg.retireHalfLifeDays * 24 * 3600 * 1000;
    const dt = now - (m.lastEpisodeAt || m.discoveredAt);
    m.decayWeight = Math.pow(0.5, dt / halfLifeMs);
    if (m.state !== 'RETIRED' && m.decayWeight < this.cfg.retireWeightFloor && dt > 6 * 3600 * 1000) {
      m.state = 'RETIRED';
      if (this.hooks.onMotifUpdate) this.hooks.onMotifUpdate(m, { retired: true });
    }
  }

  /** UI/API özeti. */
  snapshot() {
    const out = [];
    for (const m of this.motifs.values()) {
      out.push({
        motifId: m.motifId, key: m.key, chain: m.chain, state: m.state,
        episodes: m.episodes.length, pending: m.episodes.filter((e) => !e.resolvedAll).length,
        metrics: m.metrics, quarantineReason: m.quarantineReason,
        invalidators: m.invalidators, cancelStats: m.cancelStats,
        decayWeight: Number(m.decayWeight.toFixed(3)),
        graduatedHorizonSec: m.graduatedHorizonSec ?? null,
        lastEpisodeAt: m.lastEpisodeAt,
      });
    }
    return out;
  }
}

module.exports = { Learner };
