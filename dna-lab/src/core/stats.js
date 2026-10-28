'use strict';
/*
 * Market DNA V1 — İstatistik denetim araçları.
 * TÜM yöntemler şeffaf ve test edilmiştir (scripts/unit-tests.js).
 * N_eff formülleri ADAY yöntemlerdir; varsayımları ve küçük örneklem davranışları
 * birim testleriyle belgelenmiştir, körü körüne kullanılmaz (spec §6).
 */

/** Multiclass Brier skoru (3 durumlu): Σ_k (p_k - y_k)^2. */
function brierMulti(probs, outcome) {
  const classes = ['UP', 'FLAT', 'DOWN'];
  let s = 0;
  for (const c of classes) {
    const p = probs[c] ?? 0;
    const y = c === outcome ? 1 : 0;
    s += (p - y) * (p - y);
  }
  return s;
}

function logLossMulti(probs, outcome, eps = 1e-9) {
  const p = Math.max(eps, Math.min(1 - eps, probs[outcome] ?? 0));
  return -Math.log(p);
}

/** Kalibrasyon eğrisi: tahmin olasılığı bin'lerinde gözlenen frekans. */
function calibrationCurve(pairs, bins) {
  // pairs: [{p, y}] (ikili düzleştirme: her sınıf-olay çifti)
  const out = Array.from({ length: bins }, (_, i) => ({ bin: i / bins, count: 0, pSum: 0, ySum: 0 }));
  for (const { p, y } of pairs) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    out[b].count += 1; out[b].pSum += p; out[b].ySum += y ? 1 : 0;
  }
  return out.map((b) => ({
    bin: b.bin, count: b.count,
    meanP: b.count ? b.pSum / b.count : null,
    freqY: b.count ? b.ySum / b.count : null,
  }));
}

/** Expected Calibration Error. */
function ece(pairs, bins = 5) {
  const curve = calibrationCurve(pairs, bins);
  let n = 0, e = 0;
  for (const b of curve) {
    if (!b.count) continue;
    n += b.count;
    e += b.count * Math.abs(b.meanP - b.freqY);
  }
  return n ? e / n : null;
}

/**
 * Örtüşme kümeleme: aynı motifin |t0a - t0b| < windowMs episodları AYNI kümede sayılır
 * (greedy aralık kümeleme). Etkin bağımsız gözlem sayısı = küme sayısı.
 */
function overlapClusters(episodes, windowMs) {
  const sorted = [...episodes].map((e) => e.t0).sort((a, b) => a - b);
  let clusters = 0;
  let clusterEnd = -Infinity;
  for (const t0 of sorted) {
    if (t0 > clusterEnd) { clusters += 1; clusterEnd = t0 + windowMs; }
  }
  return clusters;
}

/**
 * Seri bağımlılık düzeltmesi (ADAY): N_eff = N / (1 + 2 Σ ρ_k).
 * ρ_k: ikili sonuç serisinin k-gecikme otokorelasyonu (Wald split yöntemi yerine doğrudan).
 * Küçük örneklemde ρ tahmini gürültülüdür → N_eff'i [1, N] aralığına kırpıyoruz; davranışı test edildi.
 */
function autocorrNeffect(series) {
  const n = series.length;
  if (n < 4) return n;
  const m = series.reduce((a, b) => a + b, 0) / n;
  const denom = series.reduce((a, b) => a + (b - m) ** 2, 0);
  if (denom <= 0) return n;
  let sumRho = 0;
  const maxLag = Math.min(Math.floor(n / 3), 5);
  for (let k = 1; k <= maxLag; k++) {
    let num = 0;
    for (let i = 0; i + k < n; i++) num += (series[i] - m) * (series[i + k] - m);
    const rho = num / denom;
    if (rho > 0) sumRho += rho; else break;   // negatif otokorelasyon düzeltmeyi gereksizleştirir
  }
  const neff = n / (1 + 2 * sumRho);
  return Math.max(1, Math.min(n, neff));
}

/**
 * Kombine N_eff (ADAY formül): min(örtüşme küme sayısı, seri düzeltmeli N).
 * İki düzeltme AYRI hesaplanır ve ikisinin daha muhafazakârı alınır (spec §6).
 */
function effectiveN(episodes, windowMs, outcomeSeries) {
  const nClusters = overlapClusters(episodes, windowMs);
  const nSerial = autocorrNeffect(outcomeSeries);
  return { nClusters, nSerial, nEff: Math.min(nClusters, nSerial), n: episodes.length };
}

/**
 * Eşleştirilmiş bootstrap: A ve B skorları aynı episod kümesi üzerinden;
 * küme (örtüşme) düzeyinde yeniden örnekleme yapılır. Döner: {diff, ciLow, ciHigh, pValue}.
 * pValue: tek yönlü H0: diff ≤ 0 (Brier iyileşmesi A-B).
 */
function pairedBootstrapCluster(items, resamples, conf, rng = Math.random) {
  // items: [{clusterId, a, b}] — a: motif Brier, b: baz model Brier
  if (items.length < 5) return { diff: null, ciLow: null, ciHigh: null, pValue: null, n: items.length };
  const clusters = new Map();
  for (const it of items) {
    if (!clusters.has(it.clusterId)) clusters.set(it.clusterId, []);
    clusters.get(it.clusterId).push(it);
  }
  const cl = [...clusters.values()];
  const pointDiff = meanOf(items.map((x) => x.a - x.b));
  const diffs = [];
  for (let r = 0; r < resamples; r++) {
    const sample = [];
    for (let i = 0; i < cl.length; i++) sample.push(cl[Math.floor(rng() * cl.length)]);
    const flat = sample.flat();
    diffs.push(meanOf(flat.map((x) => x.a - x.b)));
  }
  diffs.sort((x, y) => x - y);
  const alpha = (1 - conf) / 2;
  const ciLow = diffs[Math.floor(alpha * diffs.length)];
  const ciHigh = diffs[Math.floor((1 - alpha) * diffs.length)];
  let ge = 0;
  for (const d of diffs) if (d <= 0) ge += 1;
  const pValue = ge / diffs.length;
  return { diff: pointDiff, ciLow, ciHigh, pValue, n: items.length, nClusters: cl.length };
}

function meanOf(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

/** Benjamini-Hochberg FDR düzeltmesi. Döner: p listesine karşılık q değerleri. */
function benjaminiHochberg(pvals) {
  const m = pvals.length;
  const idx = pvals.map((p, i) => ({ p, i })).filter((x) => x.p !== null).sort((a, b) => a.p - b.p);
  const q = new Array(m).fill(null);
  let prev = 1;
  for (let k = idx.length - 1; k >= 0; k--) {
    const rank = k + 1;
    const v = Math.min(prev, (idx[k].p * m) / rank);
    prev = v;
    q[idx[k].i] = v;
  }
  return q;
}

/** Wilson güven aralığı (görüntüleme amaçlı isabet oranı için; kanıt olarak tek başına kullanılmaz). */
function wilson(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const denom = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return { lo: (center - spread) / denom, hi: (center + spread) / denom };
}

module.exports = { brierMulti, logLossMulti, calibrationCurve, ece, overlapClusters, autocorrNeffect, effectiveN, pairedBootstrapCluster, benjaminiHochberg, wilson, meanOf };
