/* =========================================================
   WhatNXT — Plan my day, Focus timer & Insights
   ---------------------------------------------------------
   1. FOCUS TIMER: start a timer on any task. The time you
      really spend is recorded.
   2. LEARNING: when you finish a task that had an estimate,
      WhatNXT compares "estimated" vs "actually took" and learns
      your personal speed factor (e.g. "you take 1.4× longer").
   3. PLAN MY DAY: tell WhatNXT when you are free; it fills that
      time with your most important tasks, using the learned
      factor, and warns you when you have planned too much.
   4. INSIGHTS: focus time per day, streak, best focus hour.
   Loaded after app.js and uses its helpers.
   ========================================================= */
'use strict';

const SESSIONS_KEY = 'donext.sessions.v1'; // focus sessions
const STATS_KEY = 'donext.stats.v1';       // tasks completed per day
const FOCUS_KEY = 'donext.focus.v1';       // the running timer (survives reloads)
const DEFAULT_ESTIMATE = 30;               // minutes, used when a task has no estimate

const asArray = (v) => (Array.isArray(v) ? v : []);
let sessions = asArray(readJSON(SESSIONS_KEY, []));
let stats = readJSON(STATS_KEY, {}) || {};

if (!settings.planUntil) settings.planUntil = '23:00';
if (settings.planBreak === undefined) settings.planBreak = '10';

/* ---------- Time helpers ---------- */
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
const clock = (min) => formatTime(fromMin(Math.min(min, 24 * 60 - 1)));
const round5 = (n) => Math.ceil(n / 5) * 5;
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

/* =========================================================
   Learning how long things really take
   ========================================================= */
/** Median of (actual ÷ estimate) over the last 20 finished tasks. */
function speedFactor() {
  const ratios = samples
    .slice(-20)
    .map((s) => s.actual / s.est)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (ratios.length < 3) return { factor: 1, n: ratios.length, learned: false };
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return { factor: Math.min(3, Math.max(0.5, median)), n: ratios.length, learned: true };
}

/** Called by app.js whenever a task is ticked off. */
function onTaskCompleted(t) {
  const day = dateStr();
  stats[day] = stats[day] || { done: 0 };
  stats[day].done += 1;
  writeJSON(STATS_KEY, stats);
  recordSample(t);                         // ai.js: training data for the model
  if (typeof gameOnComplete === 'function') gameOnComplete(t); // game.js: XP + badges
  // No measured time? Ask once, so the AI can learn
  if (t.estimate > 0 && t.spent < 1) setTimeout(() => askActualTime(t.id), 700);
}

/* =========================================================
   Plan my day
   ========================================================= */
function planWindow() {
  const today = dateStr();
  const now = Math.min(round5(nowMinutes()), 24 * 60 - 5);
  const chosen = settings.planFromDay === today && settings.planFrom ? toMin(settings.planFrom) : now;
  const from = Math.max(chosen, now); // can't plan in the past
  let until = toMin(settings.planUntil || '23:00');
  if (until === 0) until = 24 * 60; // "00:00" means midnight
  return { from, until };
}

function buildPlan() {
  const today = dateStr();
  const { from, until } = planWindow();
  const { factor } = speedFactor(); // shown in the UI; the plan itself uses the AI model below
  const gap = Number(settings.planBreak) || 0;
  const open = openTasks();
  // Time still needed = (estimate × your factor) − time already focused
  const need = (t) => round5(Math.max(5, predictMinutes(t) - (t.spent || 0))); // AI-predicted real duration
  const mustDo = (t) => Boolean(t.due) && dayDiff(t.due) <= 0;

  // Tasks with a set time today are pinned to that time
  const fixed = open
    .filter((t) => t.due === today && t.time && toMin(t.time) >= from && toMin(t.time) < until)
    .map((t) => ({ kind: 'fixed', task: t, start: toMin(t.time), end: Math.min(until, toMin(t.time) + need(t)) }))
    .sort((a, b) => a.start - b.start);
  const fixedIds = new Set(fixed.map((b) => b.task.id));

  // Free gaps between the pinned tasks
  const free = [];
  let cursor = from;
  for (const f of fixed) {
    if (f.start > cursor) free.push([cursor, f.start]);
    cursor = Math.max(cursor, f.end);
  }
  if (until > cursor) free.push([cursor, until]);

  const flexible = open.filter((t) => !fixedIds.has(t.id));
  const firstPass = flexible.filter(mustDo).sort(byPriority);   // due today / overdue first
  const secondPass = flexible.filter((t) => !mustDo(t)).sort(byPriority); // then get ahead

  const blocks = [...fixed];
  const overflow = [];
  const MIN_CHUNK = 15;
  // Use [start, start+len) of free gap i, adding a break after it if there's room
  const occupy = (i, len) => {
    const [a, b] = free[i];
    let next = a + len;
    if (gap && next + gap < b) {
      blocks.push({ kind: 'break', start: next, end: next + gap });
      next += gap;
    }
    if (next >= b) free.splice(i, 1);
    else free[i] = [next, b];
    return [a, a + len];
  };
  const place = (t, d, canSplit) => {
    const base = { kind: 'task', task: t, optional: !mustDo(t), guessed: !t.estimate };
    const i = free.findIndex(([a, b]) => b - a >= d);
    if (i >= 0) {
      const [start, end] = occupy(i, d);
      blocks.push({ ...base, start, end });
      return true;
    }
    // Too long for any single gap: split it across several gaps (like a real planner)
    if (!canSplit) return false;
    const usable = free.filter(([a, b]) => b - a >= MIN_CHUNK).reduce((sum, [a, b]) => sum + (b - a), 0);
    if (usable < d) return false;
    const parts = [];
    let left = d;
    for (let j = 0; j < free.length && left > 0;) {
      const [a, b] = free[j];
      if (b - a < MIN_CHUNK) { j++; continue; }
      let len = Math.min(left, b - a);
      // never leave a silly tiny last piece (e.g. 5 min)
      if (left - len > 0 && left - len < MIN_CHUNK && len - (MIN_CHUNK - (left - len)) >= MIN_CHUNK) len -= MIN_CHUNK - (left - len);
      left -= len;
      const before = free.length;
      parts.push(occupy(j, len));
      if (free.length === before) j++; // gap still has room left, move on
    }
    parts.forEach(([start, end], k) => blocks.push({ ...base, start, end, part: k + 1, parts: parts.length }));
    return true;
  };
  for (const t of firstPass) {
    const d = need(t);
    if (!place(t, d, true)) overflow.push({ task: t, need: d });
  }
  for (const t of secondPass) place(t, need(t), false);
  blocks.sort((x, y) => x.start - y.start);

  const work = blocks.filter((b) => b.kind !== 'break');
  const mustNeed = [...fixed, ...work.filter((b) => b.kind === 'task' && !b.optional)]
    .reduce((sum, b) => sum + (b.end - b.start), 0) + overflow.reduce((s, o) => s + o.need, 0);
  return {
    from, until, blocks, overflow, factor,
    freeMin: Math.max(0, until - from),
    plannedMin: work.reduce((s, b) => s + (b.end - b.start), 0),
    mustNeed,
    overflowMin: overflow.reduce((s, o) => s + o.need, 0),
  };
}

function statTile(label, value, cls = '', sub = '') {
  return el('div', { class: 'stat ' + cls },
    el('div', { class: 'k', text: label }),
    el('div', { class: 'v', text: value }),
    sub ? el('div', { class: 's', text: sub }) : null);
}

function renderPlan() {
  const p = buildPlan();
  const out = [];
  const nowMin = nowMinutes();

  // "I'm free from … until …"
  const breakSel = el('select', { 'data-plan': 'break', 'aria-label': 'Break between tasks' },
    [['0', 'none'], ['5', '5 min'], ['10', '10 min'], ['15', '15 min']].map(([v, l]) => el('option', { value: v, text: l })));
  breakSel.value = String(settings.planBreak);
  out.push(el('div', { class: 'plan-controls' },
    el('label', {}, "I'm free from", el('input', { type: 'time', 'data-plan': 'from', value: fromMin(p.from), step: 300 })),
    el('label', {}, 'until', el('input', { type: 'time', 'data-plan': 'until', value: fromMin(p.until % (24 * 60)), step: 300 })),
    el('label', {}, 'Breaks', breakSel),
  ));

  if (!openTasks().length) {
    out.push(emptyState('🗓️', 'Nothing to plan', 'Add some tasks, ideally with a time estimate like "~45m", and WhatNXT will build your day.'));
    out.push(renderInsights(), renderAiInsights());
    return out;
  }
  if (p.freeMin < 5) {
    out.push(emptyState('🌙', 'No free time left today', 'Set a later "until" time above, or rest. Tomorrow is a new plan.'));
    out.push(renderInsights(), renderAiInsights());
    return out;
  }

  // Free vs planned
  const spare = p.freeMin - p.mustNeed;
  out.push(el('div', { class: 'plan-stats' },
    statTile('Free time', fmtDur(p.freeMin)),
    statTile('Must-do work', fmtDur(p.mustNeed)),
    p.overflow.length ? statTile("Won't fit", fmtDur(p.overflowMin), 'bad') : statTile('Spare', fmtDur(Math.max(0, spare)), 'good'),
  ));

  // What WhatNXT has learned about you
  const sf = speedFactor();
  let note;
  if (sf.learned && Math.abs(sf.factor - 1) >= 0.1) {
    note = el('p', { class: 'learn-note' }, 'From your last ', el('strong', { text: plural2(sf.n, 'task') }),
      sf.factor > 1 ? ', tasks take you ' : ', you finish tasks in ',
      el('strong', { text: `${sf.factor.toFixed(1)}× your estimate` }),
      '. WhatNXT adjusts the plan for it automatically.');
  } else if (sf.learned) {
    note = el('p', { class: 'learn-note' }, el('strong', { text: 'Your estimates are spot on.' }), ` Learned from ${plural2(sf.n, 'task')}.`);
  } else {
    note = el('p', { class: 'learn-note', text: `Tip: give tasks a time estimate and use ▶ Focus. For now the plan adds 25% (most people underestimate). After ${3 - sf.n} more finished ${3 - sf.n === 1 ? 'task' : 'tasks'}, WhatNXT's AI learns your real pace.` });
  }
  out.push(note);

  // Reality check: too much for today
  if (p.overflow.length) {
    out.push(el('div', { class: 'overload' },
      el('h3', { text: `⚠️ Too much for today: ${fmtDur(p.overflowMin)} won't fit` }),
      el('p', { text: "These tasks are due but there's no time left for them. Move them now instead of feeling bad tonight:" }),
      el('ul', {}, p.overflow.map((o) => el('li', { text: `${o.task.title} (${fmtDur(o.need)})` }))),
      el('button', { type: 'button', class: 'btn small', 'data-plan-action': 'defer', text: 'Move them to tomorrow' }),
    ));
  }

  // The timeline
  let focusShown = false;
  const items = p.blocks.map((b) => {
    const isNow = b.start <= nowMin && nowMin < b.end;
    const isPast = b.end <= nowMin;
    const when = el('div', { class: 'when' }, clock(b.start), el('small', { text: fmtDur(b.end - b.start) }));
    if (b.kind === 'break') {
      return el('li', { class: 'block break' }, when, el('span', { class: 'node' }), el('div', { class: 'card', text: '☕ Break' }));
    }
    const t = b.task;
    const meta = el('div', { class: 'card-meta' },
      el('span', { class: 'chip prio', text: PRIORITIES[t.priority].label }),
      b.kind === 'fixed' ? el('span', { class: 'chip', text: `📌 at ${formatTime(t.time)}` }) : null,
      b.parts > 1 ? el('span', { class: 'chip', text: `Part ${b.part} of ${b.parts}` }) : null,
      isOverdue(t) ? el('span', { class: 'chip overdue', text: 'Overdue' }) : null,
      b.optional ? el('span', { class: 'chip', text: t.due ? `Getting ahead · ${dueLabel(t)}` : 'Getting ahead' }) : null,
      b.guessed ? el('span', { class: 'chip', title: 'No estimate set, so WhatNXT guessed 30 minutes', text: '≈ guessed time' }) : null,
      t.tag ? el('span', { class: 'chip', text: '#' + t.tag }) : null,
    );
    const showMain = !focusShown && !isPast;
    if (showMain) focusShown = true;
    const btn = el('button', { type: 'button', class: 'focus-btn' + (showMain ? ' main' : ''), 'data-action': 'focus', icon: ICON.play }, 'Focus');
    return el('li', { class: `block p-${t.priority}${b.optional ? ' optional' : ''}${isNow ? ' now' : ''}${isPast ? ' past' : ''}`, 'data-id': t.id },
      when, el('span', { class: 'node' }),
      el('div', { class: 'card' },
        el('div', { class: 'card-body' },
          el('div', { class: 'card-title' }, isNow ? el('span', { class: 'now-tag', text: 'NOW' }) : null, isNow ? ' ' : null, t.title),
          meta),
        btn));
  });
  if (items.length) {
    out.push(el('h2', { class: 'section-title' }, 'Your plan', el('span', { class: 'count', text: `· ${clock(p.from)} – ${clock(p.until)}` })));
    out.push(el('ol', { class: 'timeline' }, items));
  }

  out.push(renderInsights(), renderAiInsights());
  return out;
}

const plural2 = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* Plan controls */
content.addEventListener('change', (e) => {
  const f = e.target.closest('[data-plan]');
  if (!f) return;
  if (f.dataset.plan === 'from' && f.value) {
    settings.planFrom = f.value;
    settings.planFromDay = dateStr();
  } else if (f.dataset.plan === 'until' && f.value) {
    settings.planUntil = f.value;
  } else if (f.dataset.plan === 'break') {
    settings.planBreak = f.value;
  }
  writeJSON(SETTINGS_KEY, settings);
  render();
});
content.addEventListener('click', (e) => {
  if (!e.target.closest('[data-plan-action="defer"]')) return;
  const p = buildPlan();
  if (!p.overflow.length) return;
  rememberForUndo();
  const tomorrow = addDays(dateStr(), 1);
  for (const o of p.overflow) {
    o.task.due = tomorrow;
    o.task.time = '';
  }
  saveTasks();
  render();
  showToast(`Moved ${plural2(p.overflow.length, 'task')} to tomorrow`, true);
});

/* =========================================================
   Insights (your last 7 days)
   ========================================================= */
function renderInsights() {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDays(dateStr(), -i));
  const focusByDay = Object.fromEntries(days.map((d) => [d, 0]));
  const byHour = new Array(24).fill(0);
  const byTag = {};
  for (const s of sessions) {
    const d = new Date(s.start);
    const key = dateStr(d);
    if (key in focusByDay) {
      focusByDay[key] += s.minutes;
      byHour[d.getHours()] += s.minutes;
      const tag = s.tag || 'untagged';
      byTag[tag] = (byTag[tag] || 0) + s.minutes;
    }
  }
  const weekFocus = Object.values(focusByDay).reduce((a, b) => a + b, 0);
  const weekDone = days.reduce((sum, d) => sum + ((stats[d] && stats[d].done) || 0), 0);

  // Streak: days in a row (ending today or yesterday) with at least one task done
  let streak = 0;
  let day = (stats[dateStr()] && stats[dateStr()].done) ? dateStr() : addDays(dateStr(), -1);
  while (stats[day] && stats[day].done > 0) {
    streak++;
    day = addDays(day, -1);
  }

  const bestHour = byHour.some((m) => m > 0) ? byHour.indexOf(Math.max(...byHour)) : -1;
  const topTag = Object.entries(byTag).filter(([tag]) => tag !== 'untagged').sort((a, b) => b[1] - a[1])[0];
  const sf = speedFactor();

  const max = Math.max(30, ...Object.values(focusByDay));
  const bars = el('div', { class: 'bars', role: 'img', 'aria-label': 'Focus minutes per day, last 7 days' },
    days.map((d) => {
      const m = focusByDay[d];
      const bar = el('div', { class: 'vbar' });
      bar.style.height = `${Math.round((m / max) * 100)}%`;
      return el('div', { class: 'col' + (d === dateStr() ? ' today' : '') }, el('span', { class: 'val', text: m ? fmtDur(m) : '' }), bar);
    }));
  const labels = el('div', { class: 'bar-labels' },
    days.map((d) => el('span', { text: d === dateStr() ? 'Today' : parseDate(d).toLocaleDateString(undefined, { weekday: 'short' }) })));

  return el('section', { class: 'insights' },
    el('h3', { text: 'Your last 7 days' }),
    bars, labels,
    el('div', { class: 'ins-grid' },
      statTile('Focused', fmtDur(weekFocus), '', weekFocus ? `${fmtDur(weekFocus / 7)} a day on average` : 'Use ▶ Focus on a task'),
      statTile('Tasks done', String(weekDone), '', streak ? `🔥 ${plural2(streak, 'day')} streak` : 'Finish one today to start a streak'),
      statTile('Best focus time', bestHour < 0 ? '—' : `${formatTime(fromMin(bestHour * 60))}`, '', bestHour < 0 ? 'Not enough data yet' : 'Plan hard tasks around then'),
      statTile('Estimates', sf.learned ? `${sf.factor.toFixed(1)}×` : '—', '',
        sf.learned ? (sf.factor > 1.1 ? 'Things take longer than you think' : sf.factor < 0.9 ? "You're faster than you think" : 'Your guesses are accurate')
          : `${plural2(sf.n, 'sample')} so far, needs 3`),
    ),
    topTag && topTag[1] > 0 ? el('p', { class: 'learn-note', text: `Most of your focus went to #${topTag[0]} (${fmtDur(topTag[1])}).` }) : null,
  );
}

/* =========================================================
   Focus timer
   ========================================================= */
const focusEl = $('#focus');
const pill = $('#focusPill');
const RING_LEN = 2 * Math.PI * 52;
let tickTimer = null;
let wakeLock = null;
let baseTitle = document.title;

const getFocus = () => readJSON(FOCUS_KEY, null);
const setFocus = (st) => (st ? writeJSON(FOCUS_KEY, st) : localStorage.removeItem(FOCUS_KEY));
const elapsedMs = (st) => (st.pausedAt || Date.now()) - st.startedAt - st.pausedTotal;
const mmss = (ms) => {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

function startFocus(id) {
  const t = findTask(id);
  if (!t || t.done) return;
  const running = getFocus();
  if (running && running.taskId !== id) endFocus(false, { quiet: true });
  if (!running || running.taskId !== id) {
    const target = t.estimate ? Math.max(5, Math.round(t.estimate - (t.spent || 0))) : 25;
    setFocus({ taskId: id, startedAt: Date.now(), pausedAt: null, pausedTotal: 0, duration: target, alerted: false, estimated: Boolean(t.estimate) });
  }
  openFocus();
}

function openFocus() {
  focusEl.hidden = false;
  pill.hidden = true;
  baseTitle = baseTitle || document.title;
  $('#focusNotify').hidden = !('Notification' in window) || Notification.permission !== 'default';
  requestWakeLock();
  startTicking();
}
function minimiseFocus() {
  focusEl.hidden = true;
  if (getFocus()) pill.hidden = false;
  releaseWakeLock();
}

function startTicking() {
  clearInterval(tickTimer);
  tick();
  tickTimer = setInterval(tick, 500);
}

function tick() {
  const st = getFocus();
  const t = st && findTask(st.taskId);
  if (!st || !t || t.done) {
    if (st) setFocus(null);
    clearInterval(tickTimer);
    focusEl.hidden = true;
    pill.hidden = true;
    document.title = `${VIEWS[state.view]} · WhatNXT`;
    releaseWakeLock();
    return;
  }
  const el_ = elapsedMs(st);
  const target = st.duration * 60000;
  const left = target - el_;
  const over = left < 0;
  $('#focusTitle').textContent = t.title;
  $('#focusTime').textContent = (over ? '+' : '') + mmss(left);
  $('#focusLabel').textContent = st.pausedAt ? 'paused' : over ? 'over estimate' : 'left';
  $('#focusRing').style.strokeDasharray = RING_LEN;
  $('#focusRing').style.strokeDashoffset = RING_LEN * (1 - Math.min(1, el_ / target));
  focusEl.classList.toggle('over', over);
  focusEl.classList.toggle('paused', Boolean(st.pausedAt));
  $('#focusPause').textContent = st.pausedAt ? 'Resume' : 'Pause';
  $('#focusSub').textContent = over
    ? (st.estimated ? "Taking longer than planned. That's fine, WhatNXT learns from it." : 'Pomodoro done. Take a short break or keep going.')
    : (st.estimated ? `Target: ${fmtDur(st.duration)} · ${PRIORITIES[t.priority].label} priority` : `25-minute Pomodoro · ${PRIORITIES[t.priority].label} priority`);
  const label = `${st.pausedAt ? '⏸ ' : over ? '⏰ +' : ''}${mmss(left)}`;
  $('#focusPillText').textContent = `${label} · ${t.title}`;
  document.title = `${label} · ${t.title}`;
  if (over && !st.alerted) {
    st.alerted = true;
    setFocus(st);
    timeUp(t);
  }
}

function timeUp(t) {
  chime();
  if (navigator.vibrate) navigator.vibrate([250, 120, 250]);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const body = `Time's up for "${t.title}". Mark it done or keep going.`;
    navigator.serviceWorker && navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) reg.showNotification('WhatNXT · Focus', { body, tag: 'donext-focus', icon: 'icons/icon-192.png' });
      else new Notification('WhatNXT · Focus', { body }); // eslint-disable-line no-new
    }).catch(() => {});
  }
}

function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    [660, 880, 990].forEach((freq, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      const at = ac.currentTime + i * 0.22;
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      o.start(at);
      o.stop(at + 0.22);
    });
    setTimeout(() => ac.close(), 1500);
  } catch { /* no audio */ }
}

/** Stop the timer, save the time spent, optionally mark the task done. */
function endFocus(markDone, { quiet = false } = {}) {
  const st = getFocus();
  if (!st) return;
  const t = findTask(st.taskId);
  const minutes = Math.min(12 * 60, elapsedMs(st) / 60000);
  setFocus(null);
  clearInterval(tickTimer);
  focusEl.hidden = true;
  pill.hidden = true;
  releaseWakeLock();
  if (!t) return render();
  if (minutes >= 1 && typeof gameOnFocus === 'function') gameOnFocus(minutes, t);
  if (minutes >= 0.5) {
    t.spent = Math.round(((t.spent || 0) + minutes) * 10) / 10;
    sessions.push({ taskId: t.id, title: t.title, tag: t.tag, start: st.startedAt, minutes: Math.round(minutes * 10) / 10 });
    sessions = sessions.slice(-1000);
    writeJSON(SESSIONS_KEY, sessions);
    saveTasks();
  }
  if (markDone && !t.done) {
    toggleDone(t.id); // shows its own toast and re-renders
    if (!quiet) showToast(`Done! You focused ${fmtDur(Math.max(1, minutes))} on it.`, true);
  } else {
    render();
    if (!quiet) showToast(minutes >= 0.5 ? `Saved ${fmtDur(Math.max(1, minutes))} of focus on "${t.title}"` : 'Timer stopped');
  }
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen'); // keep the screen on while focusing
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed, fine */ }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

$('#focusPause').addEventListener('click', () => {
  const st = getFocus();
  if (!st) return;
  if (st.pausedAt) {
    st.pausedTotal += Date.now() - st.pausedAt;
    st.pausedAt = null;
  } else {
    st.pausedAt = Date.now();
  }
  setFocus(st);
  tick();
});
$('#focusPlus').addEventListener('click', () => {
  const st = getFocus();
  if (!st) return;
  st.duration += 5;
  if (elapsedMs(st) < st.duration * 60000) st.alerted = false;
  setFocus(st);
  tick();
});
$('#focusStop').addEventListener('click', () => endFocus(false));
$('#focusDone').addEventListener('click', () => endFocus(true));
$('#focusMin').addEventListener('click', minimiseFocus);
pill.addEventListener('click', openFocus);
$('#focusNotify').addEventListener('click', async () => {
  try { await Notification.requestPermission(); } catch { /* ignore */ }
  $('#focusNotify').hidden = Notification.permission !== 'default';
});
document.addEventListener('keydown', (e) => {
  if (!focusEl.hidden && e.key === 'Escape') minimiseFocus();
  if (!focusEl.hidden && e.key === ' ' && !e.target.closest('button')) {
    e.preventDefault();
    $('#focusPause').click();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !focusEl.hidden) requestWakeLock();
});

/* ---------- Start ---------- */
writeJSON(SETTINGS_KEY, settings);
if (getFocus()) {
  // A timer was running when the app was closed: keep it going, show the mini bar
  pill.hidden = false;
  startTicking();
}
render();
