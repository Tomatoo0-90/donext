/* =========================================================
   WhatNXT AI: learns how long tasks REALLY take you
   ---------------------------------------------------------
   A small machine-learning model that runs on your device.

   Every time you finish a task that had a time estimate, we
   store one training example:
       estimate, actual time, priority, tag, hour, weekday

   Model: Bayesian ridge regression on the log of the "overrun
   ratio":
       y = ln(actual / estimate)
       y ≈ w · x        (x = features below)
       residuals ~ Normal(0, σ²)

   Features x:
       bias, task size ln(estimate/30), high priority, low priority,
       afternoon / evening / night (vs morning), weekend,
       one flag per frequent #tag

   Ridge with a prior (people usually need ~25% more time than
   they guess) means it gives sensible answers from day one and
   gets personal as data comes in.

   From μ = w·x and σ we get:
       predicted time   = estimate × e^μ
       80% range        = estimate × e^(μ ± 1.28σ)
       P(done within T) = Φ( (ln(T/estimate) − μ) / σ )
   ========================================================= */
'use strict';

const SAMPLES_KEY = 'donext.samples.v1';
const AI = { MIN_SAMPLES: 3, PRIOR_RATIO: 1.25, PRIOR_SIGMA: 0.45, MAX_SAMPLES: 200 };

let samples = readJSON(SAMPLES_KEY, []);
if (!Array.isArray(samples)) samples = [];
let samplesRev = 0;

/* ---------- Math helpers ---------- */
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Solve A·x = b with Gaussian elimination (partial pivoting). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/* ---------- Features ---------- */
function timeBucket(h) {
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}
function toFeatures(s) {
  const when = new Date(s.at || Date.now());
  return {
    est: Math.max(5, Number(s.est) || 30),
    priority: s.priority || 'medium',
    tag: s.tag || '',
    hour: Number.isFinite(s.hour) ? s.hour : when.getHours(),
    dow: Number.isFinite(s.dow) ? s.dow : when.getDay(),
  };
}
const BASE_FEATURES = ['bias', 'size', 'high', 'low', 'afternoon', 'evening', 'night', 'weekend'];
function vectorize(f, tags) {
  const b = timeBucket(f.hour);
  return [
    1,
    Math.log(f.est / 30),
    f.priority === 'high' ? 1 : 0,
    f.priority === 'low' ? 1 : 0,
    b === 'afternoon' ? 1 : 0,
    b === 'evening' ? 1 : 0,
    b === 'night' ? 1 : 0,
    f.dow === 0 || f.dow === 6 ? 1 : 0,
    ...tags.map((t) => (f.tag === t ? 1 : 0)),
  ];
}

/* ---------- Training ---------- */
function fitModel(data) {
  const pts = data
    .filter((s) => s.est > 0 && s.actual > 0)
    .map((s) => ({ f: toFeatures(s), y: clamp(Math.log(s.actual / s.est), Math.log(0.2), Math.log(5)) }));
  const tagCount = {};
  for (const p of pts) if (p.f.tag) tagCount[p.f.tag] = (tagCount[p.f.tag] || 0) + 1;
  const tags = Object.entries(tagCount).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  const names = [...BASE_FEATURES, ...tags.map((t) => '#' + t)];
  const d = names.length;
  const lambda = names.map((_, i) => (i === 0 ? 1 : 3));                 // regularisation strength
  const prior = names.map((_, i) => (i === 0 ? Math.log(AI.PRIOR_RATIO) : 0)); // prior mean

  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  const X = pts.map((p) => vectorize(p.f, tags));
  pts.forEach((p, n) => {
    const x = X[n];
    for (let i = 0; i < d; i++) {
      b[i] += x[i] * p.y;
      for (let j = 0; j < d; j++) A[i][j] += x[i] * x[j];
    }
  });
  for (let i = 0; i < d; i++) {
    A[i][i] += lambda[i];
    b[i] += lambda[i] * prior[i];
  }
  const w = solve(A, b);
  let sse = 0;
  pts.forEach((p, n) => { const r = p.y - dot(w, X[n]); sse += r * r; });
  const k = 3; // prior pseudo-observations for σ
  const sigma = Math.max(0.12, Math.sqrt((sse + k * AI.PRIOR_SIGMA ** 2) / (pts.length + k)));
  const support = names.map((_, i) => X.filter((x) => x[i] !== 0).length);
  return { w, tags, names, sigma, n: pts.length, support };
}

let cachedModel = null;
let cachedRev = -1;
function getModel() {
  if (!cachedModel || cachedRev !== samplesRev) {
    cachedModel = fitModel(samples);
    cachedRev = samplesRev;
  }
  return cachedModel;
}

/* ---------- Prediction ---------- */
function predictFor(input) {
  const m = getModel();
  const f = toFeatures(input);
  const mu = dot(m.w, vectorize(f, m.tags));
  const z80 = 1.2816;
  return {
    est: f.est,
    mu,
    sigma: m.sigma,
    median: f.est * Math.exp(mu),
    low: f.est * Math.exp(mu - z80 * m.sigma),
    high: f.est * Math.exp(mu + z80 * m.sigma),
    /** probability the task takes at most T minutes */
    pWithin: (T) => (T <= 0 ? 0 : normCdf((Math.log(T / f.est) - mu) / m.sigma)),
    /** minutes needed to be `p` sure (e.g. 0.8) */
    quantile: (zScore) => f.est * Math.exp(mu + zScore * m.sigma),
    trained: m.n >= AI.MIN_SAMPLES,
    n: m.n,
  };
}
function taskInput(t) {
  return {
    est: t.estimate || DEFAULT_GUESS,
    priority: t.priority,
    tag: t.tag,
    hour: t.time ? Number(t.time.slice(0, 2)) : new Date().getHours(),
    dow: t.due ? parseDate(t.due).getDay() : new Date().getDay(),
  };
}
const DEFAULT_GUESS = 30;
/** Minutes the model thinks a task really needs (used by Plan my day). */
function predictMinutes(t) {
  return predictFor(taskInput(t)).median;
}
function deadlineTs(t) {
  if (!t.due) return null;
  const [y, m, d] = t.due.split('-').map(Number);
  if (t.time) {
    const [h, mi] = t.time.split(':').map(Number);
    return new Date(y, m - 1, d, h, mi).getTime();
  }
  return new Date(y, m - 1, d, 23, 59, 59).getTime();
}

/** The 🤖 chip on each task row. */
function predictChip(t) {
  if (t.done || !t.estimate) return null;
  const pr = predictFor(taskInput(t));
  if (!pr.trained) return null;
  const dl = deadlineTs(t);
  const minsLeft = dl ? (dl - Date.now()) / 60000 : Infinity;
  let pct;
  let text;
  let tip = `WhatNXT's AI predicts about ${fmtDur(pr.median)} (likely ${fmtDur(pr.low)}–${fmtDur(pr.high)}).`;
  if (dl && minsLeft > 0 && minsLeft < 24 * 60 && t.time) {
    // How likely to make the deadline if you start now
    pct = Math.round(pr.pWithin(minsLeft + (t.spent || 0)) * 100);
    text = `🤖 ${pct}% to make the deadline`;
    tip += ` If you start now, chance to finish before the deadline: ${pct}%.`;
  } else {
    pct = Math.round(pr.pWithin(t.estimate) * 100);
    text = `🤖 ~${fmtDur(round5ai(pr.median))} · ${pct}% within ${fmtDur(t.estimate)}`;
    tip += ` Chance to finish within your ${fmtDur(t.estimate)} estimate: ${pct}%.`;
  }
  const cls = pct >= 70 ? 'ai-good' : pct >= 40 ? 'ai-mid' : 'ai-bad';
  return el('span', { class: `chip ai ${cls}`, title: tip }, text);
}
const round5ai = (n) => Math.max(5, Math.round(n / 5) * 5);

/** Live prediction inside the add/edit dialog. */
function updateAiHint() {
  const hint = document.getElementById('aiHint');
  if (!hint) return;
  const f = document.getElementById('taskForm').elements;
  const est = Number(f.estimate.value) || 0;
  const pr = predictFor({
    est: est || DEFAULT_GUESS,
    priority: (document.querySelector('#taskForm input[name="priority"]:checked') || {}).value || 'medium',
    tag: cleanTag(f.tag.value || ''),
    hour: f.time.value ? Number(f.time.value.slice(0, 2)) : new Date().getHours(),
    dow: f.due.value ? parseDate(f.due.value).getDay() : new Date().getDay(),
  });
  hint.className = 'ai-hint';
  if (!est) {
    hint.textContent = "🤖 Pick how long you think it'll take, and WhatNXT's AI will predict whether you can really do it in that time.";
    return;
  }
  if (!pr.trained) {
    hint.textContent = `🤖 The AI is learning your pace (${pr.n}/${AI.MIN_SAMPLES} finished tasks with a measured time). Until then: most people need about 25% more time than they guess.`;
    return;
  }
  const p = Math.round(pr.pWithin(est) * 100);
  const sure = round5ai(pr.quantile(0.8416)); // 80th percentile
  hint.classList.add(p >= 70 ? 'ai-good' : p >= 40 ? 'ai-mid' : 'ai-bad');
  hint.textContent = `🤖 Prediction: about ${fmtDur(round5ai(pr.median))} (likely ${fmtDur(round5ai(pr.low))}–${fmtDur(round5ai(pr.high))}). ` +
    `Chance to finish in ${fmtDur(est)}: ${p}%.` + (p < 60 ? ` To be 80% sure, plan ${fmtDur(sure)}.` : ' Looks realistic 👍');
}
document.getElementById('taskForm').addEventListener('input', updateAiHint);
document.getElementById('taskForm').addEventListener('change', updateAiHint);

/* ---------- Collecting training data ---------- */
function recordSample(t) {
  if (!(t.estimate > 0 && t.spent >= 1)) return false;
  const first = (typeof sessions !== 'undefined' ? sessions : []).filter((s) => s.taskId === t.id).sort((a, b) => a.start - b.start)[0];
  const when = new Date(first ? first.start : Date.now());
  samples.push({ est: t.estimate, actual: t.spent, priority: t.priority, tag: t.tag, hour: when.getHours(), dow: when.getDay(), at: Date.now() });
  samples = samples.slice(-AI.MAX_SAMPLES);
  samplesRev++;
  writeJSON(SAMPLES_KEY, samples);
  return true;
}

/* "How long did it actually take?" after finishing a task without the timer */
const logDialog = document.getElementById('logDialog');
function askActualTime(id) {
  const t = findTask(id);
  if (!t || !t.done || !t.estimate || t.spent >= 1 || settings.askActual === false) return;
  if (document.querySelector('dialog[open]')) return;
  document.getElementById('logTitle').textContent = `How long did “${t.title}” really take?`;
  document.getElementById('logSub').textContent = `You guessed ${fmtDur(t.estimate)}. One tap teaches the AI your pace.`;
  const opts = [[0.5, 'much faster'], [0.75, 'a bit faster'], [1, 'as planned'], [1.5, 'longer'], [2, '2× longer'], [3, '3× longer']];
  const seen = new Set();
  document.getElementById('logChoices').replaceChildren(...opts
    .map(([mult, label]) => [round5ai(t.estimate * mult), label])
    .filter(([m]) => !seen.has(m) && seen.add(m))
    .map(([mins, label]) => el('button', { type: 'button', class: 'log-choice', 'data-mins': mins },
      el('strong', { text: fmtDur(mins) }), el('span', { text: label }))));
  logDialog.dataset.id = id;
  logDialog.showModal();
}
document.getElementById('logChoices').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mins]');
  if (!b) return;
  const t = findTask(logDialog.dataset.id);
  logDialog.close();
  if (!t) return;
  t.spent = Number(b.dataset.mins);
  saveTasks();
  recordSample(t);
  if (typeof gameOnLoggedTime === 'function') gameOnLoggedTime(t);
  render();
  showToast(predictFor(taskInput(t)).trained ? '🤖 Got it. The AI updated its predictions.' : `🤖 Got it. ${Math.max(0, AI.MIN_SAMPLES - getModel().n)} more to unlock predictions.`);
});
document.getElementById('logSkip').addEventListener('click', () => logDialog.close());
document.getElementById('logNever').addEventListener('click', () => {
  settings.askActual = false;
  writeJSON(SETTINGS_KEY, settings);
  logDialog.close();
  showToast('Okay, I won’t ask again. The focus timer still teaches the AI.');
});

/* ---------- Insights for the Plan page ---------- */
let looCache = { rev: -1, result: null };
/** Leave-one-out test: how good is the model vs your own guesses? */
function looAccuracy() {
  if (looCache.rev === samplesRev) return looCache.result;
  const data = samples.filter((s) => s.est > 0 && s.actual > 0);
  let result = null;
  if (data.length >= 5) {
    let errAi = 0;
    let errYou = 0;
    data.forEach((s, i) => {
      const m = fitModel(data.filter((_, j) => j !== i));
      const f = toFeatures(s);
      const pred = f.est * Math.exp(dot(m.w, vectorize(f, m.tags)));
      errAi += Math.abs(pred - s.actual);
      errYou += Math.abs(s.est - s.actual);
    });
    result = { maeAi: errAi / data.length, maeYou: errYou / data.length, n: data.length };
  }
  looCache = { rev: samplesRev, result };
  return result;
}

const FEATURE_TEXT = {
  size: null,
  high: ['High-priority tasks', 'vs medium'],
  low: ['Low-priority tasks', 'vs medium'],
  afternoon: ['Afternoon tasks', 'vs morning'],
  evening: ['Evening tasks', 'vs morning'],
  night: ['Late-night tasks', 'vs morning'],
  weekend: ['Weekend tasks', 'vs weekdays'],
};
function patterns(m) {
  const out = [];
  m.names.forEach((name, i) => {
    if (i === 0 || m.support[i] < 2) return;
    const w = m.w[i];
    if (Math.abs(w) < 0.15) return;
    if (name === 'size') {
      out.push({ s: Math.abs(w), text: w > 0 ? 'The bigger the task, the more you underestimate it. Split big tasks up.' : 'You overestimate big tasks. They go faster than you think.' });
      return;
    }
    const [label, vs] = name.startsWith('#') ? [`${name} tasks`, 'vs your other tasks'] : FEATURE_TEXT[name];
    const mult = Math.exp(w);
    const pct = Math.round(Math.abs(mult - 1) * 100);
    out.push({ s: Math.abs(w), text: mult > 1 ? `${label} take you ${pct}% longer (${vs}).` : `${label} go ${pct}% faster (${vs}).` });
  });
  return out.sort((a, b) => b.s - a.s).slice(0, 3).map((p) => p.text);
}

function renderAiInsights() {
  const m = getModel();
  const box = el('section', { class: 'insights ai-box' }, el('h3', { text: '🤖 AI insights' }));
  if (m.n < AI.MIN_SAMPLES) {
    const bar = el('div', { class: 'ai-progress' }, el('span'));
    bar.firstChild.style.width = `${(m.n / AI.MIN_SAMPLES) * 100}%`;
    box.append(
      el('p', { class: 'ai-line', text: `The AI is learning your pace: ${m.n}/${AI.MIN_SAMPLES} finished tasks with a measured time.` }),
      bar,
      el('p', { class: 'learn-note', text: 'Give tasks a time estimate, then use ▶ Focus (or answer "how long did it take?" when you finish). After 3, WhatNXT predicts your real time for every task and the chance you finish in the time you chose.' }),
    );
    return box;
  }
  const acc = looAccuracy();
  if (acc) {
    const better = Math.round((1 - acc.maeAi / acc.maeYou) * 100);
    box.append(el('p', { class: 'ai-line' },
      'Predicts how long a task takes within ', el('strong', { text: `±${fmtDur(Math.max(1, acc.maeAi))}` }),
      ' on average, vs ', el('strong', { text: `±${fmtDur(Math.max(1, acc.maeYou))}` }), ' for your own guesses',
      better > 0 ? el('span', { class: 'ai-better', text: ` (${better}% more accurate)` }) : ' (still learning; your guesses are closer for now)', '.'));
  } else {
    box.append(el('p', { class: 'ai-line', text: `Trained on ${m.n} tasks. Accuracy scores unlock at 5.` }));
  }
  const pats = patterns(m);
  if (pats.length) box.append(el('ul', { class: 'ai-patterns' }, pats.map((p) => el('li', { text: p }))));
  else box.append(el('p', { class: 'learn-note', text: 'No strong patterns yet. Keep timing tasks and WhatNXT will spot what slows you down.' }));
  box.append(el('p', { class: 'ai-foot', text: `Model: Bayesian ridge regression · ${m.n} examples · ${m.names.length} features · trained on this device, nothing leaves it.` }));
  return box;
}
