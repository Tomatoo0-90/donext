/* =========================================================
   DoNext Game: XP points, ranks and badges
   ---------------------------------------------------------
   + XP for finishing tasks (more for high priority)
   + bonus for beating the deadline and your own estimate
   − XP for every missed deadline (you can get demoted!)
   Ranks: Rookie → … → Master → … → God of Productivity
   ========================================================= */
'use strict';

const GAME_KEY = 'donext.game.v1';

const POINTS = {
  done: { high: 30, medium: 20, low: 10 },
  onTime: 10,          // finished before the deadline
  withinEstimate: 5,   // finished within your own estimate
  focusPer10: 2,       // per 10 minutes focused (max 30 per session)
  missed: -15,         // every missed deadline
  badge: 25,           // unlocking a badge
};

const RANKS = [
  { xp: 0, name: 'Rookie', icon: '🌱' },
  { xp: 100, name: 'Apprentice', icon: '🔰' },
  { xp: 300, name: 'Achiever', icon: '⭐' },
  { xp: 600, name: 'Pro', icon: '💪' },
  { xp: 1000, name: 'Expert', icon: '🎯' },
  { xp: 1600, name: 'Elite', icon: '💎' },
  { xp: 2500, name: 'Master', icon: '🥋' },
  { xp: 4000, name: 'Grandmaster', icon: '👑' },
  { xp: 6000, name: 'Legend', icon: '🐉' },
  { xp: 10000, name: 'God of Productivity', icon: '⚡' },
];

const BADGES = [
  { id: 'first', icon: '🚀', name: 'First Step', desc: 'Finish your first task', test: (g) => g.counts.done >= 1 },
  { id: 'ten', icon: '✅', name: 'Getting Things Done', desc: 'Finish 10 tasks', test: (g) => g.counts.done >= 10 },
  { id: 'fifty', icon: '⚙️', name: 'Machine', desc: 'Finish 50 tasks', test: (g) => g.counts.done >= 50 },
  { id: 'hundred', icon: '💯', name: 'Centurion', desc: 'Finish 100 tasks', test: (g) => g.counts.done >= 100 },
  { id: 'slayer', icon: '🗡️', name: 'Deadline Slayer', desc: 'Finish 10 tasks before their deadline', test: (g) => g.counts.onTime >= 10 },
  { id: 'prophet', icon: '🔮', name: 'Prophet', desc: 'Finish 5 tasks within your own estimate', test: (g) => g.counts.withinEst >= 5 },
  { id: 'streak7', icon: '🔥', name: 'On Fire', desc: '7-day streak', test: () => currentStreak() >= 7 },
  { id: 'streak30', icon: '🌋', name: 'Unstoppable', desc: '30-day streak', test: () => currentStreak() >= 30 },
  { id: 'deep', icon: '🧘', name: 'Deep Work', desc: 'Focus 2 hours in one day', test: () => focusToday() >= 120 },
  { id: 'early', icon: '🌅', name: 'Early Bird', desc: 'Finish 5 tasks before 9 AM', test: (g) => g.counts.early >= 5 },
  { id: 'owl', icon: '🦉', name: 'Night Owl', desc: 'Finish 5 tasks after 11 PM', test: (g) => g.counts.night >= 5 },
  { id: 'clean', icon: '🛡️', name: 'Clean Week', desc: '7 days with tasks done and no missed deadlines', test: () => cleanWeek() },
];

/* ---------- State ---------- */
function loadGame() {
  const g = readJSON(GAME_KEY, null);
  if (g && typeof g === 'object') {
    g.counts = Object.assign({ done: 0, onTime: 0, withinEst: 0, early: 0, night: 0, missed: 0 }, g.counts);
    g.log = Array.isArray(g.log) ? g.log : [];
    g.awarded = g.awarded || {};
    g.penalized = g.penalized || {};
    g.badges = g.badges || {};
    g.missedDays = g.missedDays || {};
    return g;
  }
  // First run: start fresh, and don't punish deadlines missed before the game existed
  const fresh = { xp: 0, earned: 0, log: [], awarded: {}, penalized: {}, badges: {}, missedDays: {},
    counts: { done: 0, onTime: 0, withinEst: 0, early: 0, night: 0, missed: 0 }, started: Date.now() };
  for (const t of tasks) {
    if (t.done) continue;
    const dl = deadlineTs(t);
    if (dl && Date.now() > dl) fresh.penalized[`${t.id}|${t.due}|${t.time}`] = Date.now();
  }
  return fresh;
}
let game = loadGame();
const saveGame = () => writeJSON(GAME_KEY, game);

function rankFor(xp) {
  let i = 0;
  while (i + 1 < RANKS.length && xp >= RANKS[i + 1].xp) i++;
  return { ...RANKS[i], index: i, next: RANKS[i + 1] || null };
}

/** Add or remove XP. Never goes below 0. Handles rank changes. */
function changeXP(delta, reason, opts = {}) {
  if (!delta) return;
  const before = rankFor(game.xp);
  game.xp = Math.max(0, game.xp + delta);
  if (delta > 0) game.earned += delta;
  game.log.unshift({ at: Date.now(), delta, reason });
  game.log = game.log.slice(0, 150);
  saveGame();
  updateRankChip();
  if (!opts.silent) floatXP(delta);
  const after = rankFor(game.xp);
  if (after.index > before.index) {
    later(() => {
      confetti();
      showToast(`🎉 Rank up! You're now ${after.icon} ${after.name}`, { duration: 5000 });
    }, 900);
  } else if (after.index < before.index) {
    later(() => showToast(`⬇️ Demoted to ${after.icon} ${after.name}. Missed deadlines cost XP!`, { duration: 5000 }), 900);
  }
}

/* Messages queue so toasts don't overwrite each other */
let laterDelay = 0;
function later(fn, ms) {
  laterDelay = Math.max(laterDelay, Date.now()) + ms;
  setTimeout(fn, laterDelay - Date.now());
}

/* ---------- Events from the rest of the app ---------- */
function gameOnComplete(t) {
  const now = Date.now();
  const dl = deadlineTs(t);
  let pts = POINTS.done[t.priority] || 20;
  const notes = [];
  if (dl && now <= dl) {
    pts += POINTS.onTime;
    game.counts.onTime++;
    notes.push('on time');
  } else if (dl && now > dl) {
    notes.push('late');
  }
  if (t.estimate && t.spent >= 1 && t.spent <= t.estimate) {
    pts += POINTS.withinEstimate;
    game.counts.withinEst++;
    notes.push('within estimate');
  }
  const h = new Date(now).getHours();
  if (h < 9 && h >= 4) game.counts.early++;
  if (h >= 23 || h < 4) game.counts.night++;
  game.counts.done++;
  game.awarded[t.id] = { pts, onTime: notes.includes('on time'), within: notes.includes('within estimate') };
  changeXP(pts, `Finished “${t.title}”${notes.length ? ` (${notes.join(', ')})` : ''}`);
  checkBadges();
}

/** After "how long did it take?" was answered */
function gameOnLoggedTime(t) {
  const a = game.awarded[t.id];
  if (t.estimate && t.spent <= t.estimate && a && typeof a === 'object' && !a.within) {
    a.pts += POINTS.withinEstimate;
    a.within = true;
    game.counts.withinEst++;
    changeXP(POINTS.withinEstimate, `Within your estimate: “${t.title}”`);
    checkBadges();
  }
}

function gameOnFocus(minutes, t) {
  const pts = Math.min(30, Math.floor(minutes / 10) * POINTS.focusPer10);
  if (pts > 0) changeXP(pts, `Focused ${fmtDur(minutes)} on “${t.title}”`);
  checkBadges();
}

/** Missed deadlines: called before every render (and every minute). */
function checkMissedDeadlines() {
  const now = Date.now();
  const missed = [];
  for (const t of tasks) {
    if (t.done) continue;
    const dl = deadlineTs(t);
    if (!dl || now <= dl || t.createdAt >= dl) continue;
    const key = `${t.id}|${t.due}|${t.time}`;
    if (game.penalized[key]) continue;
    game.penalized[key] = now;
    missed.push(t);
  }
  if (!missed.length) return;
  game.counts.missed += missed.length;
  game.missedDays[dateStr()] = (game.missedDays[dateStr()] || 0) + missed.length;
  // keep the map small
  const keys = Object.keys(game.penalized);
  if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete game.penalized[k];
  const total = POINTS.missed * missed.length;
  changeXP(total, missed.length === 1 ? `Missed deadline: “${missed[0].title}”` : `Missed ${missed.length} deadlines`);
  later(() => showToast(missed.length === 1
    ? `⏰ Missed deadline: “${missed[0].title}” (${total} XP)`
    : `⏰ Missed ${missed.length} deadlines (${total} XP)`, { duration: 5000 }), 300);
}

/** Undo / un-ticking a task takes its points back. */
function reconcileAwards() {
  for (const [id, a] of Object.entries(game.awarded)) {
    const t = findTask(id);
    if (t && !t.done) {
      const award = typeof a === 'number' ? { pts: a } : a;
      delete game.awarded[id];
      game.counts.done = Math.max(0, game.counts.done - 1);
      if (award.onTime) game.counts.onTime = Math.max(0, game.counts.onTime - 1);
      if (award.within) game.counts.withinEst = Math.max(0, game.counts.withinEst - 1);
      changeXP(-award.pts, `Un-done: “${t.title}”`);
    }
  }
  const ids = new Set(tasks.map((t) => t.id));
  for (const id of Object.keys(game.awarded)) if (!ids.has(id)) delete game.awarded[id]; // cleared tasks keep their XP
}

function beforeRender() {
  reconcileAwards();
  checkMissedDeadlines();
  updateRankChip();
}

/* ---------- Badges ---------- */
function currentStreak() {
  let streak = 0;
  let day = stats[dateStr()] && stats[dateStr()].done ? dateStr() : addDays(dateStr(), -1);
  while (stats[day] && stats[day].done > 0) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}
function focusToday() {
  const today = dateStr();
  return sessions.filter((s) => dateStr(new Date(s.start)) === today).reduce((a, s) => a + s.minutes, 0);
}
function cleanWeek() {
  for (let i = 0; i < 7; i++) {
    const d = addDays(dateStr(), -i);
    if (!(stats[d] && stats[d].done) || game.missedDays[d]) return false;
  }
  return true;
}
function checkBadges() {
  for (const b of BADGES) {
    if (game.badges[b.id]) continue;
    let ok = false;
    try { ok = b.test(game); } catch { ok = false; }
    if (ok) {
      game.badges[b.id] = Date.now();
      changeXP(POINTS.badge, `Badge: ${b.name}`, { silent: true });
      later(() => {
        confetti(60);
        showToast(`🏅 Badge unlocked: ${b.icon} ${b.name} (+${POINTS.badge} XP)`, { duration: 5000 });
      }, 1200);
    }
  }
  saveGame();
}

/* ---------- UI: rank chip, floating XP, confetti ---------- */
function updateRankChip() {
  const r = rankFor(game.xp);
  const chip = document.getElementById('rankChip');
  if (!chip) return;
  document.getElementById('rankIcon').textContent = r.icon;
  document.getElementById('rankName').textContent = r.name;
  document.getElementById('rankXp').textContent = `${game.xp} XP`;
  const pct = r.next ? ((game.xp - r.xp) / (r.next.xp - r.xp)) * 100 : 100;
  document.getElementById('rankBar').style.width = `${Math.max(3, Math.min(100, pct))}%`;
  chip.setAttribute('aria-label', `Rank ${r.name}, ${game.xp} XP. Open your profile`);
}

function floatXP(delta) {
  const chip = document.getElementById('rankChip');
  if (!chip) return;
  const r = chip.getBoundingClientRect();
  const f = el('div', { class: 'xp-float ' + (delta > 0 ? 'plus' : 'minus'), text: `${delta > 0 ? '+' : ''}${delta} XP` });
  f.style.left = `${r.left + r.width / 2}px`;
  f.style.top = `${r.bottom + 4}px`;
  document.body.append(f);
  setTimeout(() => f.remove(), 1600);
}

function confetti(count = 140) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  c.width = innerWidth;
  c.height = innerHeight;
  document.body.append(c);
  const ctx = c.getContext('2d');
  const colors = ['#6d5efc', '#ff6fb1', '#ffb224', '#4cc38a', '#3ab0ff', '#ff6b70'];
  const parts = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    color: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, 1 - t / 2200);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (t < 2200) requestAnimationFrame(frame);
    else c.remove();
  })(start);
}

/* ---------- Profile dialog ---------- */
const profileDialog = document.getElementById('profileDialog');
function openProfile() {
  closeMenu();
  const r = rankFor(game.xp);
  const pct = r.next ? Math.round(((game.xp - r.xp) / (r.next.xp - r.xp)) * 100) : 100;
  const bar = el('div', { class: 'xp-bar' }, el('span'));
  bar.firstChild.style.width = `${pct}%`;
  const onTimeRate = game.counts.onTime + game.counts.missed
    ? Math.round((game.counts.onTime / (game.counts.onTime + game.counts.missed)) * 100) + '%' : '—';

  const ladder = el('ol', { class: 'ladder' }, RANKS.map((k, i) => el('li', { class: i < r.index ? 'past' : i === r.index ? 'current' : '' },
    el('span', { class: 'l-icon', text: k.icon }), el('span', { class: 'l-name', text: k.name }), el('span', { class: 'l-xp', text: `${k.xp} XP` }))));

  const badges = el('div', { class: 'badge-grid' }, BADGES.map((b) => {
    const got = game.badges[b.id];
    return el('div', { class: 'badge' + (got ? ' got' : ''), title: b.desc },
      el('div', { class: 'b-icon', text: got ? b.icon : '🔒' }),
      el('div', { class: 'b-name', text: b.name }),
      el('div', { class: 'b-desc', text: b.desc }));
  }));

  const history = game.log.slice(0, 12).map((h) => el('li', {},
    el('span', { class: 'h-delta ' + (h.delta > 0 ? 'plus' : 'minus'), text: `${h.delta > 0 ? '+' : ''}${h.delta}` }),
    el('span', { class: 'h-reason', text: h.reason }),
    el('span', { class: 'h-when', text: new Date(h.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) })));

  const ask = el('input', { type: 'checkbox', id: 'askActualBox' });
  ask.checked = settings.askActual !== false;
  ask.addEventListener('change', () => { settings.askActual = ask.checked; writeJSON(SETTINGS_KEY, settings); });

  document.getElementById('profileBody').replaceChildren(
    el('div', { class: 'p-hero' },
      el('div', { class: 'p-icon', text: r.icon }),
      el('div', {},
        el('div', { class: 'p-rank', text: r.name }),
        el('div', { class: 'p-xp', text: `${game.xp} XP` + (r.next ? ` · ${r.next.xp - game.xp} XP to ${r.next.icon} ${r.next.name}` : ' · max rank!') }),
        bar)),
    el('div', { class: 'p-stats' },
      statTile('Tasks done', String(game.counts.done)),
      statTile('On-time rate', onTimeRate),
      statTile('Streak', `${currentStreak()} 🔥`),
      statTile('Missed', String(game.counts.missed), game.counts.missed ? 'bad' : '')),
    el('h3', { class: 'set-h', text: `Badges · ${Object.keys(game.badges).length}/${BADGES.length}` }),
    badges,
    el('h3', { class: 'set-h', text: 'How XP works' }),
    el('ul', { class: 'rules' },
      el('li', { text: `Finish a task: +${POINTS.done.high} high · +${POINTS.done.medium} medium · +${POINTS.done.low} low` }),
      el('li', { text: `Before its deadline: +${POINTS.onTime} bonus` }),
      el('li', { text: `Within your own time estimate: +${POINTS.withinEstimate} bonus` }),
      el('li', { text: `Focus timer: +${POINTS.focusPer10} per 10 minutes` }),
      el('li', { text: `Badge: +${POINTS.badge}` }),
      el('li', { class: 'neg', text: `Every missed deadline: ${POINTS.missed} XP (you can be demoted!)` })),
    el('h3', { class: 'set-h', text: 'Ranks' }),
    ladder,
    el('h3', { class: 'set-h', text: 'Recent XP' }),
    history.length ? el('ul', { class: 'history' }, history) : el('p', { class: 'set-note', text: 'Nothing yet. Finish a task!' }),
    el('label', { class: 'switch ask-row' }, ask, el('span', { text: 'Ask me how long finished tasks took (trains the AI)' })),
  );
  profileDialog.showModal();
}
document.getElementById('rankChip').addEventListener('click', openProfile);
for (const b of document.querySelectorAll('[data-close-profile]')) b.addEventListener('click', () => profileDialog.close());
profileDialog.addEventListener('click', (e) => { if (e.target === profileDialog) profileDialog.close(); });

/* ---------- Start ---------- */
saveGame();
checkBadges();
render();
