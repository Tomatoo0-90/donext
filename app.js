/* =========================================================
   WhatNXT — a priority-first to-do app
   Plain JavaScript, no frameworks. Data is stored in the
   browser (localStorage) on each device.
   ========================================================= */
'use strict';

/* ---------- Constants ---------- */
const STORAGE_KEY = 'donext.tasks.v1';
const SETTINGS_KEY = 'donext.settings.v1';

const PRIORITIES = {
  high:   { label: 'High',   weight: 3 },
  medium: { label: 'Medium', weight: 2 },
  low:    { label: 'Low',    weight: 1 },
};
const REPEATS = { none: 'Never', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

const VIEWS = {
  today:    'Today',
  plan:     'Plan my day',
  upcoming: 'Upcoming',
  all:      'All tasks',
  matrix:   'Priority matrix',
  done:     'Completed',
};

const ICON = {
  check:  '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  trash:  '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>',
  clock:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/></svg>',
  note:   '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  timer:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9 2h6"/></svg>',
  play:   '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  flag:   '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
};

/* ---------- Small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad = (n) => String(n).padStart(2, '0');

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/** Tiny DOM builder: el('div', {class:'x'}, child1, 'text', ...) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'icon') node.innerHTML = value; // only ever our own SVG constants
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ---------- Dates ---------- */
function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}
function addMonths(s, n) {
  const d = parseDate(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return dateStr(d);
}
/** Whole days from today until date string s (negative = in the past). */
function dayDiff(s) {
  return Math.round((parseDate(s) - parseDate(dateStr())) / 86400000);
}
function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function formatDay(s, long = false) {
  const d = parseDate(s);
  const opts = long ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
/** 95 → "1h 35m" */
function fmtDur(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
}
function dueLabel(t) {
  if (!t.due) return '';
  const diff = dayDiff(t.due);
  let label;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff > 1 && diff < 7) label = parseDate(t.due).toLocaleDateString(undefined, { weekday: 'long' });
  else label = formatDay(t.due);
  if (t.time) label += ' · ' + formatTime(t.time);
  return label;
}

/* ---------- Task model ---------- */
function cleanTag(s) {
  return String(s).trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 30);
}

/** Make sure anything we load (or import) has the right shape. */
function normalizeTask(t) {
  if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim()) return null;
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const isTime = (s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
  const done = Boolean(t.done);
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    title: t.title.trim().slice(0, 200),
    notes: typeof t.notes === 'string' ? t.notes.slice(0, 2000) : '',
    priority: PRIORITIES[t.priority] ? t.priority : 'medium',
    due: isDate(t.due) ? t.due : '',
    time: isDate(t.due) && isTime(t.time) ? t.time : '',
    tag: typeof t.tag === 'string' ? cleanTag(t.tag) : '',
    repeat: REPEATS[t.repeat] ? t.repeat : 'none',
    estimate: Number.isFinite(Number(t.estimate)) ? Math.max(0, Math.min(1440, Math.round(Number(t.estimate)))) : 0, // minutes
    spent: Number.isFinite(Number(t.spent)) ? Math.max(0, Math.round(Number(t.spent) * 10) / 10) : 0, // focused minutes
    done,
    doneAt: done ? (Number.isFinite(t.doneAt) ? t.doneAt : Date.now()) : null,
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
  };
}

function loadTasks() {
  const raw = readJSON(STORAGE_KEY, []);
  return Array.isArray(raw) ? raw.map(normalizeTask).filter(Boolean) : [];
}

let tasks = loadTasks();
let settings = Object.assign({ theme: 'system' }, readJSON(SETTINGS_KEY, {}));
const state = { view: 'today', search: '', tag: null, editingId: null };
let undoSnapshot = null;
let toastTimer = null;
let deferredInstallPrompt = null;

function saveTasks() {
  if (!writeJSON(STORAGE_KEY, tasks)) showToast('Could not save — browser storage is full or blocked');
}
function findTask(id) {
  return tasks.find((t) => t.id === id);
}
function rememberForUndo() {
  undoSnapshot = JSON.stringify(tasks);
}

/* ---------- Prioritisation ----------
   Each open task gets a score:  priority weight × 2  +  urgency
   priority: High 3, Medium 2, Low 1
   urgency:  overdue 5, today 4, tomorrow 3, ≤3 days 2, ≤7 days 1, later/no date 0
   Highest score = what you should do next. */
function isOverdue(t) {
  if (t.done || !t.due) return false;
  const diff = dayDiff(t.due);
  if (diff < 0) return true;
  if (diff === 0 && t.time) {
    const [h, m] = t.time.split(':').map(Number);
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes() > h * 60 + m;
  }
  return false;
}
function urgency(t) {
  if (!t.due) return 0;
  if (isOverdue(t)) return 5;
  const diff = dayDiff(t.due);
  if (diff === 0) return 4;
  if (diff === 1) return 3;
  if (diff <= 3) return 2;
  if (diff <= 7) return 1;
  return 0;
}
function score(t) {
  return PRIORITIES[t.priority].weight * 2 + urgency(t);
}
function byPriority(a, b) {
  return (
    score(b) - score(a) ||
    (a.due || '9999').localeCompare(b.due || '9999') ||
    (a.time || '99').localeCompare(b.time || '99') ||
    a.createdAt - b.createdAt
  );
}
function whyText(t) {
  const parts = [`${PRIORITIES[t.priority].label} priority`];
  if (!t.due) parts.push('no due date');
  else if (isOverdue(t)) parts.push('overdue');
  else {
    const diff = dayDiff(t.due);
    parts.push(diff === 0 ? 'due today' : diff === 1 ? 'due tomorrow' : `due in ${diff} days`);
  }
  if (t.time && t.due && dayDiff(t.due) === 0) parts.push(`at ${formatTime(t.time)}`);
  return parts.join(' · ');
}
// Eisenhower matrix: important = High/Medium, urgent = overdue or due today/tomorrow
const isImportant = (t) => t.priority !== 'low';
const isUrgent = (t) => Boolean(t.due) && (isOverdue(t) || dayDiff(t.due) <= 1);

/* ---------- Queries ---------- */
const openTasks = () => tasks.filter((t) => !t.done);
function matchesSearch(t) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return (t.title + ' ' + t.notes + ' ' + t.tag).toLowerCase().includes(q);
}
function allTags() {
  const counts = new Map();
  for (const t of openTasks()) if (t.tag) counts.set(t.tag, (counts.get(t.tag) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* ---------- Actions ---------- */
function addTask(data) {
  const task = normalizeTask({ ...data, id: uid(), createdAt: Date.now(), done: false });
  if (!task) return null;
  tasks.push(task);
  saveTasks();
  return task;
}

function nextOccurrence(t) {
  const today = dateStr();
  const step = (s) => (t.repeat === 'daily' ? addDays(s, 1) : t.repeat === 'weekly' ? addDays(s, 7) : addMonths(s, 1));
  let next = step(t.due || today);
  for (let i = 0; next <= today && i < 1000; i++) next = step(next);
  return next;
}

function toggleDone(id) {
  const t = findTask(id);
  if (!t) return;
  rememberForUndo();
  if (!t.done) {
    t.done = true;
    t.doneAt = Date.now();
    if (typeof onTaskCompleted === 'function') onTaskCompleted(t);
    let msg = 'Nice — task completed';
    if (t.repeat !== 'none') {
      const next = nextOccurrence(t);
      tasks.push(normalizeTask({ ...t, id: uid(), done: false, doneAt: null, due: next, createdAt: Date.now() }));
      msg = `Done · next one ${dueLabel({ due: next, time: '' }).toLowerCase()}`;
    }
    saveTasks();
    showToast(msg, true);
  } else {
    t.done = false;
    t.doneAt = null;
    saveTasks();
    showToast('Moved back to your list', true);
  }
  render();
}

function deleteTask(id) {
  const t = findTask(id);
  if (!t) return;
  rememberForUndo();
  tasks = tasks.filter((x) => x.id !== id);
  saveTasks();
  showToast('Task deleted', true);
  render();
}

function clearCompleted() {
  const count = tasks.filter((t) => t.done).length;
  if (!count) return;
  rememberForUndo();
  tasks = tasks.filter((t) => !t.done);
  saveTasks();
  showToast(`Cleared ${count} completed ${count === 1 ? 'task' : 'tasks'}`, true);
  render();
}

function undo() {
  if (!undoSnapshot) return;
  tasks = JSON.parse(undoSnapshot).map(normalizeTask).filter(Boolean);
  undoSnapshot = null;
  saveTasks();
  hideToast();
  render();
}

/* ---------- Quick-add parsing ----------
   "Submit report !h #college @tomorrow"
   !h / !m / !l  → priority
   #word        → tag
   @today, @tomorrow, @mon…@sun, @week → due date */
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function parseDueWord(w) {
  const today = dateStr();
  if (w === 'today' || w === 'tod') return today;
  if (w === 'tomorrow' || w === 'tmr' || w === 'tom') return addDays(today, 1);
  if (w === 'week' || w === 'nextweek') return addDays(today, 7);
  if (w.length >= 3) {
    const idx = DAY_NAMES.findIndex((name) => name.startsWith(w));
    if (idx >= 0) {
      let diff = (idx - new Date().getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      return addDays(today, diff);
    }
  }
  return '';
}
function parseQuick(text) {
  const out = { title: '', priority: 'medium', tag: '', due: '', estimate: 0 };
  const rest = [];
  for (const word of text.trim().split(/\s+/)) {
    const w = word.toLowerCase();
    let due;
    let est;
    if (/^!(h|high|1)$/.test(w)) out.priority = 'high';
    else if (/^!(m|med|medium|2)$/.test(w)) out.priority = 'medium';
    else if (/^!(l|low|3)$/.test(w)) out.priority = 'low';
    else if (/^#[^\s#]+$/.test(word)) out.tag = cleanTag(word);
    else if (w.startsWith('@') && (due = parseDueWord(w.slice(1)))) out.due = due;
    else if ((est = w.match(/^~(\d+(?:\.\d+)?)(m|min|mins|h|hr|hrs)?$/))) {
      out.estimate = Math.round(Number(est[1]) * (/^h/.test(est[2] || '') ? 60 : 1));
    }
    else rest.push(word);
  }
  out.title = rest.join(' ');
  return out;
}

/* ---------- Rendering ---------- */
const content = $('#content');

function taskItem(t, opts = {}) {
  const meta = el('span', { class: 'task-meta' });
  if (opts.showPriority !== false) {
    meta.append(el('span', { class: 'chip prio', icon: ICON.flag }, PRIORITIES[t.priority].label));
  }
  if (t.due) {
    const overdue = isOverdue(t);
    const cls = t.done ? 'chip' : overdue ? 'chip overdue' : dayDiff(t.due) === 0 ? 'chip today' : 'chip';
    meta.append(el('span', { class: cls, icon: ICON.clock }, overdue ? `Overdue · ${dueLabel(t)}` : dueLabel(t)));
  }
  if (t.estimate || t.spent) {
    const label = t.spent && t.estimate ? `${fmtDur(t.spent)} of ${fmtDur(t.estimate)}` : t.spent ? `${fmtDur(t.spent)} focused` : fmtDur(t.estimate);
    meta.append(el('span', { class: 'chip', icon: ICON.timer }, label));
  }
  if (t.tag) meta.append(el('span', { class: 'chip' }, '#' + t.tag));
  if (t.repeat !== 'none') meta.append(el('span', { class: 'chip', icon: ICON.repeat }, REPEATS[t.repeat]));
  if (t.notes) meta.append(el('span', { class: 'chip icon-only', icon: ICON.note, title: 'Has notes' }));
  if (typeof predictChip === 'function') meta.append(predictChip(t) || '');

  return el(
    'li',
    { class: `task p-${t.priority}${t.done ? ' done' : ''}`, 'data-id': t.id },
    el('button', {
      class: 'check',
      'data-action': 'toggle',
      'aria-label': t.done ? `Mark "${t.title}" as not done` : `Mark "${t.title}" as done`,
      icon: ICON.check,
    }),
    el('button', { class: 'task-body', 'data-action': 'edit', 'aria-label': `Edit "${t.title}"` },
      el('span', { class: 'task-title', text: t.title }),
      meta,
    ),
    t.done ? null : el('button', { class: 'del play', 'data-action': 'focus', 'aria-label': `Start focus on "${t.title}"`, title: 'Start focus timer', icon: ICON.play }),
    el('button', { class: 'del', 'data-action': 'delete', 'aria-label': `Delete "${t.title}"`, icon: ICON.trash }),
  );
}

function taskList(list, opts) {
  return el('ul', { class: 'task-list' }, list.map((t) => taskItem(t, opts)));
}

function section(title, list, opts = {}) {
  if (!list.length) return null;
  return el('div', { class: 'section' },
    el('h2', { class: 'section-title' + (opts.danger ? ' danger' : '') }, title, el('span', { class: 'count' }, `· ${list.length}`)),
    taskList(list, opts),
  );
}

function emptyState(emoji, title, text, action) {
  return el('div', { class: 'empty' },
    el('div', { class: 'big', text: emoji }),
    el('h2', { text: title }),
    el('p', { text }),
    action || null,
  );
}

function renderToday() {
  const open = openTasks().filter(matchesSearch);
  const today = dateStr();
  const doneToday = tasks.filter((t) => t.done && t.doneAt && dateStr(new Date(t.doneAt)) === today).length;
  const dueNow = open.filter((t) => t.due && dayDiff(t.due) <= 0);
  const out = [];

  const planned = doneToday + dueNow.length;
  if (planned > 0 && !state.search) {
    const pct = Math.round((doneToday / planned) * 100);
    const bar = el('div', { class: 'bar' }, el('span'));
    bar.firstChild.style.width = pct + '%';
    out.push(el('div', { class: 'progress-card' },
      el('span', { class: 'label', text: `${doneToday} of ${planned} done today` }), bar));
  }

  const ranked = [...open].sort(byPriority);
  const next = ranked[0];
  if (next && !state.search) {
    out.push(el('div', { class: 'focus-card', 'data-id': next.id },
      el('div', { class: 'eyebrow', text: 'Do this next' }),
      el('div', { class: 'focus-title', text: next.title }),
      el('p', { class: 'why', text: whyText(next) }),
      el('div', { class: 'focus-actions' },
        el('button', { 'data-action': 'focus', text: '▶ Start focus' }),
        el('button', { class: 'secondary', 'data-action': 'toggle', text: 'Mark done' }),
        el('button', { class: 'secondary', 'data-action': 'edit', text: 'Edit' }),
      ),
    ));
  }

  const rest = dueNow.filter((t) => !next || t.id !== next.id || state.search).sort(byPriority);
  out.push(section('Overdue', rest.filter(isOverdue), { danger: true }));
  out.push(section('Due today', rest.filter((t) => !isOverdue(t))));

  if (!open.length) {
    out.push(state.search
      ? emptyState('🔍', 'No matches', `Nothing open matches “${state.search}”.`)
      : emptyState('🌤️', tasks.length ? 'All clear!' : 'Welcome to WhatNXT',
        tasks.length ? 'You have no open tasks. Enjoy it, or add something new.'
          : 'Add your first task above. Give it a priority and a due date, and WhatNXT will tell you what to do next.'));
  } else if (!dueNow.length && !state.search) {
    const others = open.length - (next ? 1 : 0);
    out.push(emptyState('✅', 'Nothing else due today',
      others > 0 ? `${others} more ${others === 1 ? 'task is' : 'tasks are'} waiting with later or no due dates.` : 'You are on top of things.',
      others > 0 ? el('button', { class: 'btn ghost', 'data-goto': 'all', text: 'See all tasks' }) : null));
  }
  return out;
}

function renderUpcoming() {
  const open = openTasks().filter(matchesSearch);
  const dated = open.filter((t) => t.due && dayDiff(t.due) >= 1).sort((a, b) => a.due.localeCompare(b.due) || byPriority(a, b));
  const out = [];
  const groups = new Map();
  for (const t of dated) {
    if (!groups.has(t.due)) groups.set(t.due, []);
    groups.get(t.due).push(t);
  }
  for (const [day, list] of groups) {
    const title = dayDiff(day) === 1 ? `Tomorrow · ${formatDay(day)}` : formatDay(day, true);
    out.push(section(title, list.sort(byPriority)));
  }
  const someday = open.filter((t) => !t.due).sort(byPriority);
  out.push(section('No date', someday));
  if (!dated.length && !someday.length) {
    out.push(emptyState('📅', 'Nothing upcoming', 'Tasks with a future due date show up here, grouped by day.'));
  }
  return out;
}

function renderAll() {
  const out = [];
  const tags = allTags();
  if (state.tag && !tags.some(([tag]) => tag === state.tag)) state.tag = null;
  if (tags.length) {
    out.push(el('div', { class: 'tag-row' },
      el('button', { class: 'pill' + (state.tag ? '' : ' active'), 'data-tag': '', text: 'All' }),
      tags.map(([tag, n]) => el('button', { class: 'pill' + (state.tag === tag ? ' active' : ''), 'data-tag': tag, text: `#${tag} ${n}` })),
    ));
  }
  const list = openTasks().filter(matchesSearch).filter((t) => !state.tag || t.tag === state.tag).sort(byPriority);
  if (list.length) {
    out.push(el('div', { class: 'section' },
      el('h2', { class: 'section-title' }, 'Sorted by what to do next', el('span', { class: 'count' }, `· ${list.length}`)),
      taskList(list)));
  } else {
    out.push(state.search
      ? emptyState('🔍', 'No matches', `Nothing open matches “${state.search}”.`)
      : emptyState('📝', 'No open tasks', 'Add a task above to get started.'));
  }
  return out;
}

function renderMatrix() {
  const open = openTasks().filter(matchesSearch);
  const quads = [
    { title: 'Do first', desc: 'Important and urgent', color: 'var(--high)', test: (t) => isImportant(t) && isUrgent(t) },
    { title: 'Schedule', desc: 'Important, not urgent — plan a time', color: 'var(--accent)', test: (t) => isImportant(t) && !isUrgent(t) },
    { title: 'Quick wins', desc: 'Urgent, low priority — do fast or hand off', color: 'var(--medium)', test: (t) => !isImportant(t) && isUrgent(t) },
    { title: 'Later', desc: 'Neither — do it if you have spare time', color: 'var(--low)', test: (t) => !isImportant(t) && !isUrgent(t) },
  ];
  return [
    el('p', { class: 'matrix-help', text: 'Important = High or Medium priority. Urgent = overdue or due by tomorrow.' }),
    el('div', { class: 'matrix' }, quads.map((q) => {
      const list = open.filter(q.test).sort(byPriority);
      const dot = el('span', { class: 'dot' });
      dot.style.background = q.color;
      return el('div', { class: 'quad' },
        el('h3', {}, dot, q.title, el('span', { class: 'count', text: list.length ? ` · ${list.length}` : '' })),
        el('p', { class: 'desc', text: q.desc }),
        list.length ? taskList(list, { showPriority: false }) : el('div', { class: 'empty-mini', text: 'Nothing here' }));
    })),
  ];
}

function renderDone() {
  const list = tasks.filter((t) => t.done).filter(matchesSearch).sort((a, b) => b.doneAt - a.doneAt);
  if (!list.length) return [emptyState('🏁', 'Nothing completed yet', 'Tick off a task and it will show up here.')];
  return [
    el('div', { class: 'tag-row' }, el('button', { class: 'btn ghost small danger', 'data-clear': '', text: 'Clear all completed' })),
    section('Completed', list),
  ];
}

const RENDERERS = { plan: () => renderPlan(), today: renderToday, upcoming: renderUpcoming, all: renderAll, matrix: renderMatrix, done: renderDone };

function updateHeader() {
  $('#viewTitle').textContent = VIEWS[state.view];
  const open = openTasks();
  let sub = '';
  if (state.view === 'today') sub = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  else if (state.view === 'all') sub = `${open.length} open ${open.length === 1 ? 'task' : 'tasks'}`;
  else if (state.view === 'upcoming') sub = 'What is coming up, day by day';
  else if (state.view === 'plan') sub = 'Your free time, filled with what matters most';
  else if (state.view === 'matrix') sub = 'Sort your tasks by importance and urgency';
  else if (state.view === 'done') sub = `${tasks.length - open.length} completed`;
  $('#viewSub').textContent = sub;
  document.title = `${VIEWS[state.view]} · WhatNXT`;

  const counts = {
    today: open.filter((t) => t.due && dayDiff(t.due) <= 0).length,
    upcoming: open.filter((t) => t.due && dayDiff(t.due) >= 1).length,
    all: open.length,
  };
  for (const badge of $$('[data-count]')) badge.textContent = counts[badge.dataset.count] || '';
  for (const btn of $$('.nav-item')) {
    const active = btn.dataset.view === state.view;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
}

function render() {
  if (typeof beforeRender === 'function') beforeRender(); // game.js: deadlines, XP
  updateHeader();
  content.replaceChildren(...RENDERERS[state.view]().filter(Boolean));
  $('#tagList').replaceChildren(...allTags().map(([tag]) => el('option', { value: tag })));
}

/* ---------- Task dialog ---------- */
const dialog = $('#taskDialog');
const form = $('#taskForm');
const fields = form.elements;

function openDialog(id = null, preset = {}) {
  const t = id ? findTask(id) : null;
  state.editingId = t ? t.id : null;
  const data = t || { title: '', priority: 'medium', due: '', time: '', tag: '', repeat: 'none', notes: '', estimate: 0, ...preset };
  $('#dlgTitle').textContent = t ? 'Edit task' : 'New task';
  fields.title.value = data.title;
  fields.title.classList.remove('invalid');
  form.querySelector(`input[name="priority"][value="${data.priority}"]`).checked = true;
  fields.due.value = data.due;
  fields.time.value = data.time;
  fields.tag.value = data.tag;
  fields.repeat.value = data.repeat;
  const est = String(data.estimate || 0);
  if (![...fields.estimate.options].some((o) => o.value === est)) fields.estimate.append(el('option', { value: est, text: fmtDur(Number(est)) }));
  fields.estimate.value = est;
  fields.notes.value = data.notes;
  $('#dlgDelete').hidden = !t;
  if (typeof updateAiHint === 'function') updateAiHint();
  closeMenu();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  // On phones, don't pop the keyboard over the form when editing
  if (!t || window.matchMedia('(min-width: 760px)').matches) fields.title.focus();
}
function closeDialog() {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  state.editingId = null;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = fields.title.value.trim();
  if (!title) {
    fields.title.classList.add('invalid');
    fields.title.focus();
    return;
  }
  let due = fields.due.value;
  const time = fields.time.value;
  const repeat = fields.repeat.value;
  if (!due && (time || repeat !== 'none')) due = dateStr(); // a time or repeat needs a date
  const data = {
    title,
    priority: form.querySelector('input[name="priority"]:checked')?.value || 'medium',
    due,
    time: due ? time : '',
    tag: cleanTag(fields.tag.value),
    repeat,
    estimate: Number(fields.estimate.value) || 0,
    notes: fields.notes.value.trim(),
  };
  if (state.editingId) {
    const t = findTask(state.editingId);
    if (t) {
      Object.assign(t, normalizeTask({ ...t, ...data }));
      saveTasks();
      showToast('Task updated');
    }
  } else {
    addTask(data);
    showToast('Task added');
  }
  closeDialog();
  render();
});

fields.title.addEventListener('input', () => fields.title.classList.remove('invalid'));
for (const btn of $$('[data-close]', dialog)) btn.addEventListener('click', closeDialog);
dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); }); // click on backdrop
dialog.addEventListener('close', () => { state.editingId = null; });
$('#dlgDelete').addEventListener('click', () => {
  const id = state.editingId;
  closeDialog();
  if (id) deleteTask(id);
});
for (const btn of $$('[data-due]', dialog)) {
  btn.addEventListener('click', () => {
    fields.due.value = btn.dataset.due === '' ? '' : addDays(dateStr(), Number(btn.dataset.due));
    if (!fields.due.value) fields.time.value = '';
  });
}

/* ---------- Toast ---------- */
let toastAction = null;
/** showToast(msg, true) shows an Undo button.
    showToast(msg, { actionLabel, onAction, duration }) shows a custom button. */
function showToast(message, opts = false) {
  const o = typeof opts === 'object' && opts ? opts : { undo: Boolean(opts) };
  const toast = $('#toast');
  const btn = $('#toastUndo');
  $('#toastMsg').textContent = message;
  toastAction = o.undo ? undo : o.onAction || null;
  btn.textContent = o.undo ? 'Undo' : o.actionLabel || 'OK';
  btn.hidden = !toastAction;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, o.duration || (toastAction ? 6000 : 2500));
}
function hideToast() {
  $('#toast').hidden = true;
}
$('#toastUndo').addEventListener('click', () => {
  const fn = toastAction;
  hideToast();
  if (fn) fn();
});

/* ---------- Menu, theme, backup, install ---------- */
const menu = $('#menu');
const menuBtn = $('#menuBtn');
function closeMenu() {
  menu.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  menuBtn.setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !e.target.closest('.menu-wrap')) closeMenu();
});

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  $('#themeLabel').textContent = { system: 'System', light: 'Light', dark: 'Dark' }[settings.theme] || 'System';
}

function exportBackup() {
  const extras = {};
  for (const k of EXTRA_KEYS) extras[k] = readJSON(k, null);
  const payload = { app: 'WhatNXT', version: 2, exportedAt: new Date().toISOString(), tasks, extras };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `whatnxt-backup-${dateStr()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Backup downloaded');
}

const EXTRA_KEYS = ['donext.game.v1', 'donext.samples.v1', 'donext.sessions.v1', 'donext.stats.v1'];
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data && Array.isArray(data.tasks) ? data.tasks : null;
    if (!list) throw new Error('bad format');
    const incoming = list.map(normalizeTask).filter(Boolean);
    rememberForUndo();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    let added = 0;
    let updated = 0;
    for (const t of incoming) {
      if (byId.has(t.id)) updated++;
      else added++;
      byId.set(t.id, t);
    }
    tasks = [...byId.values()];
    saveTasks();
    // Rank, XP and AI training data: keep whichever device has more progress
    const ex = data && data.extras;
    const localGame = readJSON('donext.game.v1', null);
    if (ex && ex['donext.game.v1'] && (!localGame || (ex['donext.game.v1'].earned || 0) >= (localGame.earned || 0))) {
      for (const k of EXTRA_KEYS) if (ex[k] != null) writeJSON(k, ex[k]);
      showToast('Imported tasks, XP and AI data. Reloading…');
      setTimeout(() => location.reload(), 1200);
      return;
    }
    render();
    showToast(`Imported: ${added} new, ${updated} updated`, true);
  } catch {
    showToast('That file is not a WhatNXT backup');
  }
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

async function installApp() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    return;
  }
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
  showToast(iOS
    ? 'On iPhone/iPad: tap Share, then “Add to Home Screen”'
    : 'Use your browser menu → “Install app” or “Add to Home screen”');
}

menu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-menu]');
  if (!item) return;
  const action = item.dataset.menu;
  if (action === 'theme') {
    const order = ['system', 'light', 'dark'];
    settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
    writeJSON(SETTINGS_KEY, settings);
    applyTheme();
    return; // keep menu open so you can keep cycling
  }
  closeMenu();
  if (action === 'export') exportBackup();
  else if (action === 'import') $('#importFile').click();
  else if (action === 'install') installApp();
});
$('#importFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importBackup(file);
  e.target.value = '';
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});
window.addEventListener('appinstalled', () => {
  $('#installItem').hidden = true;
  showToast('WhatNXT installed 🎉');
});

/* ---------- Wiring ---------- */
for (const btn of $$('.nav-item')) {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    render();
    window.scrollTo({ top: 0 });
  });
}

content.addEventListener('click', (e) => {
  const gotoBtn = e.target.closest('[data-goto]');
  if (gotoBtn) {
    state.view = gotoBtn.dataset.goto;
    render();
    return;
  }
  const tagBtn = e.target.closest('[data-tag]');
  if (tagBtn) {
    state.tag = tagBtn.dataset.tag || null;
    render();
    return;
  }
  if (e.target.closest('[data-clear]')) {
    clearCompleted();
    return;
  }
  const actionEl = e.target.closest('[data-action]');
  const holder = e.target.closest('[data-id]');
  if (!actionEl || !holder) return;
  const id = holder.dataset.id;
  const action = actionEl.dataset.action;
  if (action === 'toggle') {
    const item = holder.classList.contains('task') ? holder : null;
    if (item && !findTask(id)?.done && state.view !== 'done') {
      item.classList.add('done', 'leaving');
      setTimeout(() => toggleDone(id), 220);
    } else {
      toggleDone(id);
    }
  } else if (action === 'edit') openDialog(id);
  else if (action === 'delete') deleteTask(id);
  else if (action === 'focus' && typeof startFocus === 'function') startFocus(id);
});

$('#quickAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#quickInput');
  const parsed = parseQuick(input.value);
  if (!parsed.title) {
    showToast('Type a task name first');
    input.focus();
    return;
  }
  addTask(parsed);
  input.value = '';
  const where = parsed.due && dayDiff(parsed.due) >= 1 && state.view === 'today' ? ' (see Upcoming)' : '';
  showToast(`Added “${parsed.title}”${where}`);
  render();
});
$('#detailsBtn').addEventListener('click', () => {
  const input = $('#quickInput');
  const parsed = parseQuick(input.value);
  input.value = '';
  openDialog(null, parsed);
});
$('#fab').addEventListener('click', () => openDialog(null, { due: state.view === 'today' ? dateStr() : '' }));

const searchInput = $('#search');
searchInput.addEventListener('input', () => {
  state.search = searchInput.value;
  searchInput.closest('.search').classList.toggle('has-value', Boolean(state.search));
  render();
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape' && !menu.hidden) closeMenu();
  const focusOpen = document.getElementById('focus') && !document.getElementById('focus').hidden;
  if (typing || focusOpen || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    $('#quickInput').focus();
  } else if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
  }
});

// Keep dates fresh (e.g. app left open past midnight) and sync between tabs
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
setInterval(() => {
  const editing = document.activeElement && content.contains(document.activeElement) && document.activeElement.matches('input, select');
  if (!document.hidden && !dialog.open && !editing) render();
}, 60000);
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    tasks = loadTasks();
    render();
  }
});

/* ---------- "Desktop site" detection ----------
   Phones with "Desktop site" switched on pretend to be a computer: the page gets a
   ~980px wide screen, so the laptop layout shows up tiny. We spot it by a touch
   screen that is phone-sized but a user-agent that claims to be a desktop. */
function checkDesktopMode() {
  const ua = navigator.userAgent;
  const claimsDesktop = !/Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const touch = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
  const phoneScreen = Math.min(screen.width, screen.height) < 600;
  const stretched = window.innerWidth > Math.min(screen.width, screen.height) * 1.5;
  const tip = $('#desktopModeTip');
  if (!(claimsDesktop && touch && phoneScreen && stretched) || settings.desktopTipHidden) {
    tip.hidden = true;
    return;
  }
  const apple = /Macintosh/.test(ua);
  $('#desktopModeHow').textContent = apple
    ? 'In Safari tap the “aA” button in the address bar → “Request Mobile Website”.'
    : 'In Chrome tap ⋮ (top right) and untick “Desktop site”. If WhatNXT is installed as an app: open Chrome → Settings → Site settings → Desktop site → turn it off, then reopen WhatNXT.';
  // Scale the message up so it is readable on the zoomed-out page
  const scale = Math.max(1, window.innerWidth / Math.min(screen.width, screen.height));
  tip.style.fontSize = Math.round(15 * scale) + 'px';
  tip.hidden = false;
}
$('#desktopModeOk').addEventListener('click', () => {
  settings.desktopTipHidden = true;
  writeJSON(SETTINGS_KEY, settings);
  $('#desktopModeTip').hidden = true;
});
window.addEventListener('resize', checkDesktopMode);

/* ---------- Start ---------- */
applyTheme();
checkDesktopMode();
if (isStandalone()) $('#installItem').hidden = true;
render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  });
}
