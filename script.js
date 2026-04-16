'use strict';

/* ── Constants ──────────────────────────────────────────────────────── */
const STORAGE_KEY_V3   = 'shift-timeline-v3';
const STORAGE_KEY_V2   = 'shift-timeline-v2';
const MIN_SEGMENT_MS   = 60_000;          // 1 min minimum
const TICK_MS          = 1000;
const WARN_THRESHOLD   = 30 * 60 * 1000; // 30 min unallocated
const FUTURE_BUFFER_MS = 30 * 60 * 1000; // visible future strip beyond playhead

const DEFAULT_LABELS = [
  { name: 'Work',         type: 'work',     color: '#3b82f6' },
  { name: 'Meeting',      type: 'work',     color: '#8b5cf6' },
  { name: 'Admin',        type: 'work',     color: '#6366f1' },
  { name: 'Break',        type: 'non-work', color: '#10b981' },
  { name: 'Interruption', type: 'non-work', color: '#f97316' },
];

/* ── State ──────────────────────────────────────────────────────────── */
let state = {
  shiftStart: 0,
  shiftEnd:   0,
  segments:   [],   // { id, start, end|null, labelName, note }
  labels:     [],   // { name, type, color }
  settings:   { use24h: true },
};

let selectedSegId      = null;
let contextTargetSegId = null;
let tooltipEl          = null;
let bannerEl           = null;
let bannerSegId        = null;
let lastWarnCheck      = 0;

/* ── Utilities ──────────────────────────────────────────────────────── */
function snap(ms) {
  const half = 30 * 60 * 1000;
  return Math.round(ms / half) * half;
}

function formatTime(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  if (state.settings.use24h) return `${String(h).padStart(2,'0')}:${m}`;
  const suffix = h >= 12 ? 'pm' : 'am';
  return `${(h % 12) || 12}:${m}${suffix}`;
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatShort(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}` : `${m}:${String(s % 60).padStart(2,'0')}`;
}

function msToTimeInput(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function timeInputToMs(str, refMs) {
  const [h, m] = str.split(':').map(Number);
  const d = new Date(refMs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function uid() { return Math.random().toString(36).slice(2, 10); }

function getLabelObj(name) {
  return state.labels.find(l => l.name === name) || null;
}

function getLabelColor(name) {
  const l = getLabelObj(name);
  return l ? l.color : '#9ca3af';
}

function getLabelType(name) {
  const l = getLabelObj(name);
  return l ? l.type : 'unallocated';
}

function escapeCSV(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function shiftDurationMs() {
  return state.shiftEnd - state.shiftStart;
}

// Dynamic viewport: show [shiftStart, shiftStart + elapsed + buffer], clamped to full shift.
// Keeps the present and past proportionally large at the start of the shift.
function viewDurationMs() {
  const total = shiftDurationMs();
  if (total <= 0) return 0;
  const elapsed = Math.max(0, Math.min(Date.now() - state.shiftStart, total));
  return Math.min(total, elapsed + FUTURE_BUFFER_MS);
}

/* ── Persistence & migration ────────────────────────────────────────── */
function migrateState(p) {
  if (!p.labels)   p.labels   = [...DEFAULT_LABELS];
  if (!p.settings) p.settings = { use24h: true };
  if (p.segments) {
    p.segments.forEach(seg => {
      if ('label' in seg && !('labelName' in seg)) { seg.labelName = seg.label || null; delete seg.label; }
      if (!('labelName' in seg)) seg.labelName = null;
      if (!('note' in seg)) seg.note = '';
      // promote unknown label names into the labels list
      if (seg.labelName && !p.labels.find(l => l.name === seg.labelName)) {
        p.labels.push({ name: seg.labelName, type: 'work', color: '#6b7280' });
      }
    });
  }
  return p;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_V3) || localStorage.getItem(STORAGE_KEY_V2);
    if (!raw) return false;
    const p = JSON.parse(raw);
    if (!p || !p.shiftStart || !Array.isArray(p.segments)) return false;
    state = migrateState(p);
    return true;
  } catch { return false; }
}

/* ── Shift init ─────────────────────────────────────────────────────── */
function initShift(preserveMeta) {
  const snapped = snap(Date.now());
  const prev = preserveMeta ? { labels: state.labels, settings: state.settings } : null;
  state = {
    shiftStart: snapped,
    shiftEnd:   snapped + 8 * 3600 * 1000,
    segments:   [{ id: uid(), start: snapped, end: null, labelName: null, note: '' }],
    labels:     prev ? prev.labels   : [...DEFAULT_LABELS],
    settings:   prev ? prev.settings : { use24h: true },
  };
  saveState();
}

function isExpired() { return Date.now() > state.shiftEnd + 3600_000; }

/* ── DOM ────────────────────────────────────────────────────────────── */
const $shiftBtn     = document.getElementById('shift-btn');
const $ruler        = document.getElementById('time-ruler');
const $track        = document.getElementById('timeline-track');
const $segs         = document.getElementById('segments-container');
const $playhead     = document.getElementById('playhead');
const $future       = document.getElementById('future-overlay');
const $editor       = document.getElementById('editor-panel');
const $edTime       = document.getElementById('editor-seg-time');
const $edClose      = document.getElementById('editor-close');
const $chips        = document.getElementById('category-chips');
const $splitHalf    = document.getElementById('split-halves-btn');
const $splitN       = document.getElementById('split-n-btn');
const $mergePrev    = document.getElementById('merge-prev-btn');
const $mergeNext    = document.getElementById('merge-next-btn');
const $notes        = document.getElementById('notes-input');
const $resetBtn     = document.getElementById('reset-btn');
const $themeBtn     = document.getElementById('theme-btn');
const $fmtBtn       = document.getElementById('time-format-btn');
const $labelsBtn    = document.getElementById('labels-btn');
const $exportBtn    = document.getElementById('export-btn');
const $exportMenu   = document.getElementById('export-menu');
const $importFile   = document.getElementById('import-file');
const $ctxMenu      = document.getElementById('context-menu');
const $dropOverlay  = document.getElementById('drop-overlay');
const $toasts       = document.getElementById('toast-container');
const $legend       = document.getElementById('legend');
const $statWork     = document.getElementById('stat-work');
const $statNonwork  = document.getElementById('stat-nonwork');
const $statUnalloc  = document.getElementById('stat-unallocated');
const $statSegs     = document.getElementById('stat-segments');
const $statIntr     = document.getElementById('stat-interruptions');
const $statLongest  = document.getElementById('stat-longest');
const $statAvg      = document.getElementById('stat-avg');

/* ── Toast ──────────────────────────────────────────────────────────── */
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function toastWithUndo(msg, onUndo) {
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-undo';
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => { onUndo(); el.remove(); });
  el.append(span, btn);
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

/* ── Tooltip ────────────────────────────────────────────────────────── */
function getTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'seg-tooltip';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}
function moveTooltip(e) {
  const t = getTooltip();
  t.style.left = (e.clientX + 14) + 'px';
  t.style.top  = (e.clientY - 32) + 'px';
}

/* ── Cut ────────────────────────────────────────────────────────────── */
function cut() {
  const now = Date.now();
  if (now >= state.shiftEnd)   { toast('Shift has ended.'); return; }
  if (now <  state.shiftStart) { toast('Shift has not started yet.'); return; }
  const open = state.segments.find(s => s.end === null);
  if (!open) return;
  const lastEnd = Math.max(...state.segments.filter(s => s.end).map(s => s.end), 0);
  if (lastEnd && now - lastEnd < 3000) { toast('Too soon — wait a moment.'); return; }
  open.end = now;
  state.segments.push({ id: uid(), start: now, end: null, labelName: null, note: '' });
  saveState();
  renderTimeline();
  renderStats();
  checkWarn();
}

/* ── Selection ──────────────────────────────────────────────────────── */
function selectSeg(id) {
  selectedSegId = id;
  renderTimeline();
  openEditor();
}

function deselect() {
  selectedSegId = null;
  renderTimeline();
  closeEditor();
}

/* ── Editor ─────────────────────────────────────────────────────────── */
function openEditor() {
  const seg = state.segments.find(s => s.id === selectedSegId);
  if (!seg) return;
  getTooltip().classList.remove('visible');
  const now = Date.now();
  const end = seg.end || Math.min(now, state.shiftEnd);
  $edTime.textContent = `${formatTime(seg.start)} – ${seg.end ? formatTime(seg.end) : 'now'} · ${formatDuration(end - seg.start)}`;

  // chips
  $chips.innerHTML = '';
  [{ name: null, display: 'Unallocated', color: '#9ca3af' },
   ...state.labels.map(l => ({ name: l.name, display: l.name, color: l.color }))
  ].forEach(({ name, display, color }) => {
    const c = document.createElement('span');
    c.className = 'chip' + (seg.labelName === name ? ' active' : (!seg.labelName && name === null ? ' active' : ''));
    c.textContent = display;
    c.style.background = color;
    c.addEventListener('click', () => applyLabel(name));
    $chips.appendChild(c);
  });

  $notes.value = seg.note || '';

  const idx = state.segments.findIndex(s => s.id === selectedSegId);
  $mergePrev.disabled = idx <= 0;
  $mergeNext.disabled = idx >= state.segments.length - 1;

  $editor.classList.remove('hidden');
}

function closeEditor() { $editor.classList.add('hidden'); }

function applyLabel(name) {
  const seg = state.segments.find(s => s.id === selectedSegId);
  if (!seg) return;
  seg.labelName = name;
  saveState();
  renderTimeline();
  renderStats();
  renderLegend();
  openEditor();
  toast(name ? `Labeled: ${name}` : 'Marked as Unallocated');
}

/* notes auto-save */
let noteSaveTimer = null;
$notes.addEventListener('input', () => {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(() => {
    const seg = state.segments.find(s => s.id === selectedSegId);
    if (seg) { seg.note = $notes.value; saveState(); }
  }, 400);
});

/* ── Stats ──────────────────────────────────────────────────────────── */
function renderStats() {
  const now = Date.now();
  let work = 0, nonwork = 0, unalloc = 0, interruptions = 0, longestWork = 0;
  const elapsed = Math.min(now, state.shiftEnd) - state.shiftStart;

  state.segments.forEach(seg => {
    const e = seg.end || Math.min(now, state.shiftEnd);
    const d = Math.max(0, e - seg.start);
    const t = getLabelType(seg.labelName);
    if (t === 'work')     { work    += d; if (d > longestWork) longestWork = d; }
    else if (t === 'non-work') { nonwork += d; interruptions++; }
    else                       { unalloc += d; }
  });

  const count = state.segments.length;
  $statWork.textContent     = formatShort(work);
  $statNonwork.textContent  = formatShort(nonwork);
  $statUnalloc.textContent  = formatShort(unalloc);
  $statSegs.textContent     = count;
  $statIntr.textContent     = interruptions;
  $statLongest.textContent  = longestWork > 0 ? formatShort(longestWork) : '—';
  $statAvg.textContent      = count > 0 ? formatShort(elapsed / count) : '—';
}

/* ── Legend ─────────────────────────────────────────────────────────── */
function renderLegend() {
  if (!$legend) return;
  $legend.innerHTML = '';
  state.labels.forEach(l => {
    const el = document.createElement('span');
    el.className = 'legend-item';
    el.textContent = l.name;
    el.style.background = l.color;
    el.title = l.type;
    $legend.appendChild(el);
  });
}

/* ── Timeline ───────────────────────────────────────────────────────── */
function renderRuler() {
  $ruler.innerHTML = '';
  if (!$track.offsetWidth) return;
  const total = viewDurationMs();
  if (total <= 0) return;
  const step  = 30 * 60 * 1000;
  for (let t = 0; t <= total; t += step) {
    const el = document.createElement('div');
    el.className = 'ruler-tick' + (t % (3600_000) === 0 ? ' major' : '');
    el.style.left = (t / total * 100) + '%';
    el.textContent = formatTime(state.shiftStart + t);
    $ruler.appendChild(el);
  }
}

function renderTimeline() {
  const now   = Date.now();
  const total = viewDurationMs();
  if (!$track.offsetWidth || total <= 0) return;

  const shiftTotal = shiftDurationMs();
  const elapsed    = Math.max(0, Math.min(now - state.shiftStart, shiftTotal));
  const phPct      = elapsed / total * 100;

  $playhead.style.left = phPct + '%';
  $future.style.left   = phPct + '%';
  document.title = `${formatTime(state.shiftStart)}–${formatTime(state.shiftEnd)}`;

  $segs.innerHTML = '';

  state.segments.forEach((seg, i) => {
    const sStart = Math.max(seg.start, state.shiftStart);
    const sEnd   = seg.end ? Math.min(seg.end, state.shiftEnd) : Math.min(now, state.shiftEnd);
    const lPct   = (sStart - state.shiftStart) / total * 100;
    const wPct   = Math.max(0, (sEnd - sStart) / total * 100);
    if (wPct <= 0) return;

    const el = document.createElement('div');
    el.className = 'segment' + (seg.id === selectedSegId ? ' selected' : '') + (wPct > 3 ? ' wide' : '');
    el.style.left       = lPct + '%';
    el.style.width      = wPct + '%';
    el.style.background = getLabelColor(seg.labelName);

    const lbl = document.createElement('div');
    lbl.className   = 'segment-label';
    lbl.textContent = seg.labelName || 'Unallocated';
    el.appendChild(lbl);

    el.addEventListener('mouseenter', e => {
      const t = getTooltip();
      const dur = (seg.end || now) - seg.start;
      const note = seg.note ? ` · "${seg.note.slice(0,40)}"` : '';
      t.textContent = `${seg.labelName || 'Unallocated'} · ${formatDuration(dur)} · ${formatTime(seg.start)}–${formatTime(seg.end || now)}${note}`;
      t.classList.add('visible');
      moveTooltip(e);
    });
    el.addEventListener('mousemove', moveTooltip);
    el.addEventListener('mouseleave', () => getTooltip().classList.remove('visible'));
    el.addEventListener('click', e => { e.stopPropagation(); getTooltip().classList.remove('visible'); seg.id === selectedSegId ? deselect() : selectSeg(seg.id); });
    el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showCtxMenu(e, seg.id); });

    $segs.appendChild(el);

    // boundary drag handle between this seg and next
    if (i < state.segments.length - 1 && seg.end !== null) {
      const hPct = (seg.end - state.shiftStart) / total * 100;
      const h = document.createElement('div');
      h.className = 'seg-handle';
      h.style.left = hPct + '%';
      h.addEventListener('mousedown', e => startDrag(e, seg.id, state.segments[i + 1].id));
      $segs.appendChild(h);
    }
  });
}

/* ── Boundary drag ──────────────────────────────────────────────────── */
function startDrag(e, leftId, rightId) {
  e.preventDefault(); e.stopPropagation();
  const rect = $track.getBoundingClientRect();
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  function onMove(ev) {
    const total = viewDurationMs();
    const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const boundary = state.shiftStart + pct * total;
    const left  = state.segments.find(s => s.id === leftId);
    const right = state.segments.find(s => s.id === rightId);
    if (!left || !right) return;
    const rightMax = right.end || Math.min(Date.now(), state.shiftEnd);
    const clamped  = Math.max(left.start + MIN_SEGMENT_MS, Math.min(rightMax - MIN_SEGMENT_MS, boundary));
    left.end   = clamped;
    right.start = clamped;
    renderTimeline();
  }
  function onUp() {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveState(); renderStats();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/* ── Warn banner ────────────────────────────────────────────────────── */
function checkWarn() {
  const now  = Date.now();
  const open = state.segments.find(s => s.end === null);
  if (!open || open.labelName) { hideBanner(); return; }
  const dur = now - open.start;
  if (dur >= WARN_THRESHOLD) showBanner(open, dur); else hideBanner();
}

function showBanner(seg, dur) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.id = 'unallocated-banner';
    bannerEl.innerHTML = '<span></span><button>Split or label</button>';
    bannerEl.querySelector('button').addEventListener('click', () => { selectSeg(bannerSegId); hideBanner(); });
    document.getElementById('stats-panel').insertAdjacentElement('afterend', bannerEl);
  }
  bannerSegId = seg.id;
  bannerEl.querySelector('span').textContent = `Large unallocated block: ${formatDuration(dur)}`;
  bannerEl.classList.remove('hidden');
}

function hideBanner() { if (bannerEl) bannerEl.classList.add('hidden'); }

/* ── Theme ──────────────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem('shift-theme');
  if (saved === 'dark' || (!saved && matchMedia('(prefers-color-scheme:dark)').matches))
    document.documentElement.setAttribute('data-theme', 'dark');
}
function toggleTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  localStorage.setItem('shift-theme', dark ? 'light' : 'dark');
}

/* ── Time format ────────────────────────────────────────────────────── */
function toggleFormat() {
  state.settings.use24h = !state.settings.use24h;
  $fmtBtn.textContent = state.settings.use24h ? '24h' : '12h';
  saveState(); renderRuler(); renderTimeline();
}

/* ── Context menu (stub — wired in part 2) ──────────────────────────── */
function showCtxMenu(e, segId) {
  contextTargetSegId = segId || null;
  const now  = Date.now();
  const idx  = segId ? state.segments.findIndex(s => s.id === segId) : -1;
  const has  = idx !== -1;
  const shiftActive = now >= state.shiftStart && now < state.shiftEnd;

  document.getElementById('cm-cut').classList.toggle('disabled', !shiftActive);
  document.getElementById('cm-merge-prev').classList.toggle('disabled', !(has && idx > 0));
  document.getElementById('cm-merge-next').classList.toggle('disabled', !(has && idx < state.segments.length - 1));

  $ctxMenu.classList.remove('hidden');
  const mw = 200;
  let x = e.clientX, y = e.clientY;
  if (x + mw > innerWidth) x = innerWidth - mw - 8;
  $ctxMenu.style.left = x + 'px';
  $ctxMenu.style.top  = y + 'px';
}
function hideCtxMenu() { $ctxMenu.classList.add('hidden'); contextTargetSegId = null; }

/* ── Tick ───────────────────────────────────────────────────────────── */
function tick() {
  const now = Date.now();
  renderRuler();
  renderTimeline();
  renderStats();
  if (now - lastWarnCheck > 30_000) { lastWarnCheck = now; checkWarn(); }
  const open = state.segments.find(s => s.end === null);
  if (open && now >= state.shiftEnd) {
    open.end = state.shiftEnd;
    saveState();
    toast('Shift ended — segments closed.');
  }
}

/* ── Init (part 1) ──────────────────────────────────────────────────── */
function init() {
  initTheme();
  auth.handleCallback();
  if (!loadState() || isExpired()) initShift(false);
  $fmtBtn.textContent = state.settings.use24h ? '24h' : '12h';
  renderRuler();
  renderTimeline();
  renderStats();
  renderLegend();
  new ResizeObserver(() => { renderRuler(); renderTimeline(); }).observe($track);

  // basic event wiring (rest in part 2)
  $themeBtn.addEventListener('click', toggleTheme);
  $fmtBtn.addEventListener('click', toggleFormat);
  $edClose.addEventListener('click', deselect);
  $splitHalf.addEventListener('click', () => { if (selectedSegId) splitInto(selectedSegId, 2); });
  $mergePrev.addEventListener('click', mergeWithPrev);
  $mergeNext.addEventListener('click', mergeWithNext);
  $track.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showCtxMenu(e, null); });
  $future.addEventListener('click', e => { e.stopPropagation(); cut(); });

  document.addEventListener('contextmenu', e => {
    if (!$ctxMenu.contains(e.target)) hideCtxMenu();
  });

  document.addEventListener('click', e => {
    if (!$ctxMenu.contains(e.target)) hideCtxMenu();
    if (!$exportMenu.contains(e.target) && e.target !== $exportBtn) $exportMenu.classList.add('hidden');
    if (selectedSegId && !$editor.contains(e.target) && !$track.contains(e.target)) deselect();
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') { deselect(); hideCtxMenu(); }
  });

  setInterval(tick, TICK_MS);

  const setBlur = b => document.body.classList.toggle('window-blurred', b);
  window.addEventListener('blur',  () => setBlur(true));
  window.addEventListener('focus', () => setBlur(false));
  setBlur(!document.hasFocus());

  document.getElementById('dock-btn').addEventListener('click', dockWindow);
  if (isStandalonePWA()) setTimeout(dockWindow, 120);

  wireCloud();
}

/* ── Cloud sync (sign-in, save/load to server) ──────────────────────── */
function wireCloud() {
  const $btn   = document.getElementById('cloud-btn');
  const $menu  = document.getElementById('cloud-menu');
  const $panel = document.getElementById('shifts-panel');
  const $list  = document.getElementById('shifts-list');

  function refreshBtn() {
    $btn.textContent = auth.isAuthenticated() ? '☁ ✓' : '☁';
    $btn.title       = auth.isAuthenticated() ? 'Cloud sync' : 'Sign in to sync';
  }
  refreshBtn();

  $btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!auth.isAuthenticated()) { auth.login(); return; }
    $menu.classList.toggle('hidden');
  });

  document.addEventListener('click', e => {
    if (!$menu.contains(e.target) && e.target !== $btn) $menu.classList.add('hidden');
  });

  $menu.addEventListener('click', async e => {
    const a = e.target.dataset.action;
    if (!a) return;
    $menu.classList.add('hidden');
    if (a === 'cloud-save')    await saveToServer();
    if (a === 'cloud-load')    await openShiftsPanel();
    if (a === 'cloud-signout') { auth.logout(); refreshBtn(); toast('Signed out'); }
  });

  function closeShiftsPanel() {
    $panel.classList.add('hidden');
    document.getElementById('timeline-wrapper').classList.remove('hidden');
  }

  async function saveToServer() {
    const payload = {
      _meta: { version: '3', exported: new Date().toISOString(), app: 'Shift Timeline' },
      state: JSON.parse(JSON.stringify(state)),
    };
    try {
      await auth.apiCall('save', { method: 'POST', body: JSON.stringify(payload) });
      toast('Saved to server');
    } catch (e) {
      toast('Save failed: ' + e.message);
    }
  }

  function backLink() {
    const a = document.createElement('a');
    a.href = '#'; a.textContent = '← Back';
    a.style.cssText = 'font-size:11px;color:var(--text-muted);display:inline-block;padding:4px 0;';
    a.addEventListener('click', e => { e.preventDefault(); closeShiftsPanel(); });
    const wrap = document.createElement('div');
    wrap.style.padding = '2px 0';
    wrap.appendChild(a);
    return wrap;
  }

  async function openShiftsPanel() {
    hideForPanel();
    $list.innerHTML = '<div style="padding:6px 0;color:var(--text-muted);font-size:11px">Loading…</div>';
    $panel.classList.remove('hidden');
    let shifts;
    try {
      const data = await auth.apiCall('list');
      shifts = data.shifts || [];
    } catch (e) {
      $list.innerHTML = '';
      $list.append(backLink());
      $list.insertAdjacentHTML('beforeend', `<div style="padding:4px 0;color:var(--text-muted);font-size:11px">Load failed: ${e.message}</div>`);
      return;
    }
    if (!shifts.length) {
      $list.innerHTML = '';
      $list.append(backLink());
      $list.insertAdjacentHTML('beforeend', '<div style="padding:4px 0;color:var(--text-muted);font-size:11px">No saved shifts yet.</div>');
      return;
    }
    $list.innerHTML = '';
    $list.append(backLink());
    shifts.forEach(s => {
      const row = document.createElement('div');
      row.className = 'shift-row';
      const date = new Date(s.shift_start);
      const dur  = Math.round((s.shift_end - s.shift_start) / 60000);
      row.innerHTML = `
        <span class="shift-date">${date.toLocaleDateString('en-CA')}</span>
        <span class="shift-time">${msToTimeInput(s.shift_start)}–${msToTimeInput(s.shift_end)}</span>
        <span class="shift-meta">${dur} min · ${s.segments} seg</span>`;
      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => loadShift(s.shift_start));
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'Delete from server';
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this shift from the server?')) return;
        try { await auth.apiCall('delete', { query: { shift_start: s.shift_start } }); row.remove(); }
        catch (e) { toast('Delete failed: ' + e.message); }
      });
      row.append(loadBtn, delBtn);
      $list.appendChild(row);
    });
  }

  async function loadShift(shiftStart) {
    try {
      const data = await auth.apiCall('fetch', { query: { shift_start: shiftStart } });
      const incoming = data.state || data;
      if (!incoming.shiftStart || !Array.isArray(incoming.segments)) { toast('Invalid payload'); return; }
      if (!confirm('Replace current session with this saved shift?')) return;
      state = migrateState(incoming);
      saveState();
      selectedSegId = null; closeEditor(); hideBanner();
      $panel.classList.add('hidden');
      document.getElementById('timeline-wrapper').classList.remove('hidden');
      renderRuler(); renderTimeline(); renderStats(); renderLegend();
      toast('Shift loaded from server');
    } catch (e) {
      toast('Load failed: ' + e.message);
    }
  }
}

/* ── Auto-dock (PWA only) ───────────────────────────────────────────── */
function isStandalonePWA() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches
      || window.navigator.standalone === true;
}
function dockWindow() {
  const wrap = document.getElementById('timeline-wrapper');
  const stats = document.getElementById('stats-panel');
  const content = (wrap?.offsetHeight || 60) + (stats?.offsetHeight || 40);
  const chrome  = Math.max(0, window.outerHeight - window.innerHeight);
  const h = Math.min(screen.availHeight, content + chrome + 4);
  const w = screen.availWidth;
  try {
    window.moveTo(0, screen.availHeight - h);
    window.resizeTo(w, h);
  } catch { /* regular tabs silently ignore */ }
}

/* ── Split & Merge (needed by editor buttons above) ─────────────────── */
function splitInto(id, n) {
  const idx = state.segments.findIndex(s => s.id === id);
  if (idx === -1 || n < 2) return;
  const seg = state.segments[idx];
  const now = Date.now();
  const end = seg.end || Math.min(now, state.shiftEnd);
  if (end <= seg.start) return;
  const chunk = (end - seg.start) / n;
  const fresh = Array.from({ length: n }, (_, i) => ({
    id: uid(),
    start: seg.start + i * chunk,
    end:   seg.end !== null || i < n - 1 ? seg.start + (i + 1) * chunk : null,
    labelName: null,
    note: '',
  }));
  state.segments.splice(idx, 1, ...fresh);
  selectedSegId = fresh[0].id;
  saveState(); renderTimeline(); renderStats(); openEditor();
  toast(`Split into ${n} segments`);
}

function mergeWithPrev() {
  const idx = state.segments.findIndex(s => s.id === selectedSegId);
  if (idx > 0) mergePair(idx - 1, idx);
}
function mergeWithNext() {
  const idx = state.segments.findIndex(s => s.id === selectedSegId);
  if (idx < state.segments.length - 1) mergePair(idx, idx + 1);
}
function mergePair(li, ri) {
  const L = state.segments[li], R = state.segments[ri];
  if (!L || !R) return;
  const snapshot = JSON.parse(JSON.stringify(state.segments));
  const prevSelected = selectedSegId;
  const now = Date.now();
  const lDur = (L.end || now) - L.start;
  const rDur = (R.end || now) - R.start;
  const merged = {
    id: uid(),
    start: L.start,
    end:   R.end,
    labelName: lDur >= rDur ? L.labelName : R.labelName,
    note: [L.note, R.note].filter(Boolean).join(' | '),
  };
  state.segments.splice(li, 2, merged);
  selectedSegId = merged.id;
  saveState(); renderTimeline(); renderStats(); openEditor();
  toastWithUndo('Segments merged', () => {
    state.segments = snapshot;
    selectedSegId = prevSelected;
    saveState(); renderTimeline(); renderStats();
    if (selectedSegId) openEditor(); else closeEditor();
  });
}

/* ══════════════════════════════════════════════════════════════════════
   PART 2 — context menu, labels manager, shift adjust, exports, import
   ══════════════════════════════════════════════════════════════════════ */

/* ── Context menu actions ───────────────────────────────────────────── */
$ctxMenu.addEventListener('click', e => {
  const item = e.target.closest('.cm-item');
  if (!item || item.classList.contains('disabled')) return;
  const target = contextTargetSegId;
  hideCtxMenu();
  switch (item.id) {
    case 'cm-cut':        cut(); break;
    case 'cm-merge-prev': if (target) { selectedSegId = target; mergeWithPrev(); } break;
    case 'cm-merge-next': if (target) { selectedSegId = target; mergeWithNext(); } break;
  }
});

/* ── Number prompt ──────────────────────────────────────────────────── */
function showPrompt(msg, def, onOk) {
  const ov = document.getElementById('prompt-overlay');
  document.getElementById('prompt-label').textContent = msg;
  const inp = document.getElementById('prompt-input');
  inp.value = def;
  ov.classList.remove('hidden');
  inp.focus(); inp.select();
  const ok = () => { const v = parseInt(inp.value, 10); ov.classList.add('hidden'); if (v >= 2) onOk(v); };
  const cancel = () => ov.classList.add('hidden');
  document.getElementById('prompt-ok').onclick     = ok;
  document.getElementById('prompt-cancel').onclick = cancel;
  inp.onkeydown = e => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') cancel(); };
  ov.onclick    = e => { if (e.target === ov) cancel(); };
}
$splitN.addEventListener('click', () => {
  if (selectedSegId) showPrompt('Split into how many equal parts?', 3, n => splitInto(selectedSegId, n));
});

/* ── Reset ──────────────────────────────────────────────────────────── */
$resetBtn.addEventListener('click', () => {
  if (!confirm('Reset shift? Segment data will be cleared. Labels and settings are kept.')) return;
  initShift(true);
  selectedSegId = null;
  closeEditor(); hideBanner();
  renderRuler(); renderTimeline(); renderStats(); renderLegend();
  toast('New shift started');
});

/* ── Panel show/hide helpers ────────────────────────────────────────── */
function restoreTimeline() {
  document.getElementById('timeline-wrapper').classList.remove('hidden');
  document.getElementById('shift-panel').classList.add('hidden');
  document.getElementById('labels-panel').classList.add('hidden');
}

function hideForPanel() {
  if (selectedSegId) deselect();
  document.getElementById('timeline-wrapper').classList.add('hidden');
}

/* ── Custom 24h time picker ─────────────────────────────────────────── */
function initTimePicker(rootEl) {
  const hidden = document.getElementById(rootEl.dataset.target);
  const $h = rootEl.querySelector('.tp-hours');
  const $m = rootEl.querySelector('.tp-minutes');

  function sync() {
    const [h, m] = (hidden.value || '00:00').split(':').map(n => parseInt(n, 10) || 0);
    $h.textContent = String(h).padStart(2, '0');
    $m.textContent = String(m).padStart(2, '0');
  }
  function step(unit, delta) {
    let h = parseInt($h.textContent, 10);
    let m = parseInt($m.textContent, 10);
    if (unit === 'hours') {
      h = (h + delta + 24) % 24;
    } else {
      const total = h * 60 + m + delta;
      const norm  = ((total % 1440) + 1440) % 1440;
      h = Math.floor(norm / 60);
      m = norm % 60;
    }
    hidden.value = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    sync();
  }
  rootEl.addEventListener('click', e => {
    const btn = e.target.closest('.tp-btn');
    if (!btn) return;
    step(btn.dataset.unit, Number(btn.dataset.delta));
  });
  rootEl.querySelectorAll('.tp-col').forEach(col => {
    col.addEventListener('wheel', e => {
      e.preventDefault();
      const base = col.dataset.unit === 'minutes' ? 5 : 1;
      step(col.dataset.unit, e.deltaY > 0 ? -base : base);
    }, { passive: false });
  });
  hidden._tpSync = sync;
  sync();
}
document.querySelectorAll('.time-picker').forEach(initTimePicker);

/* ── Shift time adjustment ──────────────────────────────────────────── */
function openShiftModal() {
  hideForPanel();
  const start = document.getElementById('shift-start-input');
  const end   = document.getElementById('shift-end-input');
  start.value = msToTimeInput(state.shiftStart);
  end.value   = msToTimeInput(state.shiftEnd);
  start._tpSync && start._tpSync();
  end._tpSync   && end._tpSync();
  document.getElementById('shift-warning').textContent = '';
  document.getElementById('shift-panel').classList.remove('hidden');
}

document.getElementById('shift-apply-btn').addEventListener('click', () => {
  const startStr = document.getElementById('shift-start-input').value;
  const endStr   = document.getElementById('shift-end-input').value;
  if (!startStr || !endStr) return;

  let newStart = timeInputToMs(startStr, state.shiftStart);
  let newEnd   = timeInputToMs(endStr,   state.shiftStart);
  if (newEnd <= newStart) newEnd += 86_400_000; // crosses midnight

  const warn = document.getElementById('shift-warning');
  warn.textContent = newEnd - newStart > 43_200_000 ? 'Warning: shift is over 12 hours.' : '';

  const oldStart = state.shiftStart;

  // slide first segment if it was anchored to old start
  if (state.segments.length && state.segments[0].start === oldStart)
    state.segments[0].start = newStart;

  // drop segments fully outside new window, clamp overlapping ones
  state.segments = state.segments.filter(seg => {
    const e = seg.end || newEnd;
    return seg.start < newEnd && e > newStart;
  });
  state.segments.forEach(seg => {
    if (seg.start < newStart) seg.start = newStart;
    if (seg.end !== null && seg.end > newEnd) seg.end = newEnd;
  });
  if (!state.segments.length)
    state.segments = [{ id: uid(), start: newStart, end: null, labelName: null, note: '' }];

  state.shiftStart = newStart;
  state.shiftEnd   = newEnd;
  saveState();
  restoreTimeline();
  renderRuler(); renderTimeline(); renderStats();
  toast('Shift times updated');
});

$shiftBtn.addEventListener('click', openShiftModal);
document.getElementById('shift-panel-cancel').addEventListener('click', restoreTimeline);

/* ── Labels manager ─────────────────────────────────────────────────── */
function openLabelsModal() {
  hideForPanel();
  renderLabelsList();
  document.getElementById('labels-panel').classList.remove('hidden');
}

function renderLabelsList() {
  const list = document.getElementById('labels-list');
  list.innerHTML = '';
  state.labels.forEach((lbl, i) => {
    const row = document.createElement('div');
    row.className = 'label-row';

    const swatch = document.createElement('input');
    swatch.type = 'color'; swatch.value = lbl.color;
    swatch.className = 'label-color-swatch';
    swatch.addEventListener('input', e => {
      lbl.color = e.target.value; saveState(); renderTimeline(); renderLegend();
    });

    const nameEl = document.createElement('input');
    nameEl.type = 'text'; nameEl.value = lbl.name; nameEl.maxLength = 30;
    nameEl.className = 'label-name-input';
    nameEl.addEventListener('change', e => {
      const nv = e.target.value.trim();
      if (!nv) { e.target.value = lbl.name; return; }
      if (state.labels.some((l, j) => j !== i && l.name === nv)) {
        toast('That name already exists'); e.target.value = lbl.name; return;
      }
      const old = lbl.name; lbl.name = nv;
      state.segments.forEach(s => { if (s.labelName === old) s.labelName = nv; });
      saveState(); renderTimeline(); renderLegend();
      if (selectedSegId) openEditor();
    });

    const typeEl = document.createElement('select');
    typeEl.className = 'label-type-select';
    ['work', 'non-work'].forEach(t => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t; if (t === lbl.type) o.selected = true;
      typeEl.appendChild(o);
    });
    typeEl.addEventListener('change', e => { lbl.type = e.target.value; saveState(); renderStats(); });

    const del = document.createElement('button');
    del.className = 'label-del-btn'; del.textContent = '✕'; del.title = 'Delete label';
    del.addEventListener('click', () => {
      if (!confirm(`Delete "${lbl.name}"? Segments using it become Unallocated.`)) return;
      const name = lbl.name;
      state.labels.splice(i, 1);
      state.segments.forEach(s => { if (s.labelName === name) s.labelName = null; });
      saveState(); renderLabelsList(); renderTimeline(); renderLegend(); renderStats();
      if (selectedSegId) openEditor();
    });

    row.append(swatch, nameEl, typeEl, del);
    list.appendChild(row);
  });
}

document.getElementById('add-label-btn').addEventListener('click', () => {
  const color = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  state.labels.push({ name: 'New Label', type: 'work', color });
  saveState(); renderLabelsList(); renderLegend();
  const rows = document.querySelectorAll('.label-row');
  if (rows.length) rows[rows.length - 1].querySelector('input[type="text"]')?.select();
});

document.getElementById('labels-done-btn').addEventListener('click', restoreTimeline);

$labelsBtn.addEventListener('click', openLabelsModal);

/* ── Export helpers ─────────────────────────────────────────────────── */
function download(content, name, mime) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([content], { type: mime })),
    download: name,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function dateStamp(ms) { return new Date(ms).toLocaleDateString('en-CA').replace(/-/g, ''); }

function buildCSV(rows) { return rows.map(r => r.map(escapeCSV).join(',')).join('\n'); }

/* ── Export JSON (briefcase) ────────────────────────────────────────── */
function exportJSON() {
  const payload = JSON.stringify({
    _meta: { version: '3', exported: new Date().toISOString(), app: 'Shift Timeline' },
    state: JSON.parse(JSON.stringify(state)),
  }, null, 2);
  download(payload, `shift-${dateStamp(state.shiftStart)}.json`, 'application/json');
  toast('Briefcase exported');
}

/* ── Export CSV — detailed ──────────────────────────────────────────── */
function exportCSVDetail() {
  const now = Date.now();
  const rows = [['#', 'Date', 'Start', 'End', 'Duration (min)', 'Label', 'Type', 'Notes']];
  state.segments.forEach((seg, i) => {
    const end = seg.end || Math.min(now, state.shiftEnd);
    rows.push([
      i + 1,
      new Date(seg.start).toLocaleDateString('en-CA'),
      msToTimeInput(seg.start),
      msToTimeInput(end),
      Math.round((end - seg.start) / 60000),
      seg.labelName || 'Unallocated',
      getLabelType(seg.labelName),
      seg.note || '',
    ]);
  });
  download(buildCSV(rows), `shift-detail-${dateStamp(state.shiftStart)}.csv`, 'text/csv');
  toast('Detailed CSV exported');
}

/* ── Export CSV — summary ───────────────────────────────────────────── */
function exportCSVSummary() {
  const now    = Date.now();
  const totals = {};
  state.segments.forEach(seg => {
    const end = seg.end || Math.min(now, state.shiftEnd);
    const dur = Math.max(0, end - seg.start);
    const key = seg.labelName || 'Unallocated';
    if (!totals[key]) totals[key] = { dur: 0, count: 0, type: getLabelType(seg.labelName) };
    totals[key].dur += dur; totals[key].count++;
  });
  const elapsed = Math.min(now, state.shiftEnd) - state.shiftStart;
  const rows = [['Label', 'Type', 'Segments', 'Total (min)', 'Percentage']];
  Object.entries(totals)
    .sort((a, b) => b[1].dur - a[1].dur)
    .forEach(([name, d]) => rows.push([
      name, d.type, d.count,
      Math.round(d.dur / 60000),
      elapsed > 0 ? (d.dur / elapsed * 100).toFixed(1) + '%' : '0%',
    ]));
  const grandDur   = Object.values(totals).reduce((a, b) => a + b.dur,   0);
  const grandCount = Object.values(totals).reduce((a, b) => a + b.count, 0);
  rows.push(['TOTAL', '', grandCount, Math.round(grandDur / 60000),
    elapsed > 0 ? (grandDur / elapsed * 100).toFixed(1) + '%' : '0%']);
  download(buildCSV(rows), `shift-summary-${dateStamp(state.shiftStart)}.csv`, 'text/csv');
  toast('Summary CSV exported');
}

/* ── Export menu wiring ─────────────────────────────────────────────── */
$exportBtn.addEventListener('click', e => { e.stopPropagation(); $exportMenu.classList.toggle('hidden'); });
$exportMenu.addEventListener('click', e => {
  $exportMenu.classList.add('hidden');
  const a = e.target.dataset.action;
  if (a === 'export-json')        exportJSON();
  else if (a === 'export-csv-detail')   exportCSVDetail();
  else if (a === 'export-csv-summary')  exportCSVSummary();
});

/* ── Import from file ───────────────────────────────────────────────── */
function importFromFile(file) {
  if (!file || !file.name.endsWith('.json')) { toast('Please select a .json briefcase file'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      const incoming = parsed.state || parsed;
      if (!incoming.shiftStart || !Array.isArray(incoming.segments)) { toast('Invalid briefcase file'); return; }
      if (!confirm('Replace current session with the imported briefcase?')) return;
      state = migrateState(incoming);
      saveState();
      selectedSegId = null; closeEditor(); hideBanner();
      renderRuler(); renderTimeline(); renderStats(); renderLegend();
      toast('Session restored from briefcase');
    } catch { toast('Could not read file'); }
  };
  reader.readAsText(file);
}

$importFile.addEventListener('change', e => {
  importFromFile(e.target.files[0]);
  e.target.value = '';
});

/* ── Drag-and-drop import ───────────────────────────────────────────── */
(function initDragDrop() {
  let counter = 0;
  document.addEventListener('dragenter', e => {
    if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { counter++; $dropOverlay.classList.remove('hidden'); }
  });
  document.addEventListener('dragleave', () => { if (--counter <= 0) { counter = 0; $dropOverlay.classList.add('hidden'); } });
  document.addEventListener('dragover',  e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault(); counter = 0; $dropOverlay.classList.add('hidden');
    importFromFile(e.dataTransfer.files[0]);
  });
})();

/* ── Modal close helpers (prompt only) ─────────────────────────────── */
const $promptOverlay = document.getElementById('prompt-overlay');
$promptOverlay.addEventListener('click', e => { if (e.target === $promptOverlay) $promptOverlay.classList.add('hidden'); });

init();
