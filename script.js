'use strict';

/* ── Constants ──────────────────────────────────────────────────────── */
const STORAGE_KEY_V3   = 'shift-timeline-v3';
const STORAGE_KEY_V2   = 'shift-timeline-v2';
const MIN_SEGMENT_MS   = 60_000;          // 1 min minimum
const TICK_MS          = 1000;
const WARN_THRESHOLD   = 30 * 60 * 1000; // 30 min unallocated

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
  settings:   { use24h: false },
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

/* ── Persistence & migration ────────────────────────────────────────── */
function migrateState(p) {
  if (!p.labels)   p.labels   = [...DEFAULT_LABELS];
  if (!p.settings) p.settings = { use24h: false };
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
    settings:   prev ? prev.settings : { use24h: false },
  };
  saveState();
}

function isExpired() { return Date.now() > state.shiftEnd + 3600_000; }

/* ── DOM ────────────────────────────────────────────────────────────── */
const $shiftRange   = document.getElementById('shift-time-range');
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
  const total = shiftDurationMs();
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
  const total = shiftDurationMs();
  if (!$track.offsetWidth || total <= 0) return;

  const elapsed = Math.max(0, Math.min(now - state.shiftStart, total));
  const phPct   = elapsed / total * 100;

  $playhead.style.left = phPct + '%';
  $future.style.left   = phPct + '%';
  $shiftRange.textContent = `${formatTime(state.shiftStart)} – ${formatTime(state.shiftEnd)}`;

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
    el.addEventListener('click', e => { e.stopPropagation(); seg.id === selectedSegId ? deselect() : selectSeg(seg.id); });
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
  const total = shiftDurationMs();
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  function onMove(ev) {
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
  document.getElementById('cm-edit').classList.toggle('disabled', !has);
  document.getElementById('cm-merge-prev').classList.toggle('disabled', !(has && idx > 0));
  document.getElementById('cm-merge-next').classList.toggle('disabled', !(has && idx < state.segments.length - 1));
  document.getElementById('cm-split-half').classList.toggle('disabled', !has);
  document.getElementById('cm-split-n').classList.toggle('disabled', !has);

  $ctxMenu.classList.remove('hidden');
  const mw = 200, mh = 250;
  let x = e.clientX, y = e.clientY;
  if (x + mw > innerWidth)  x = innerWidth  - mw - 8;
  if (y + mh > innerHeight) y = innerHeight - mh - 8;
  $ctxMenu.style.left = x + 'px';
  $ctxMenu.style.top  = y + 'px';
}
function hideCtxMenu() { $ctxMenu.classList.add('hidden'); contextTargetSegId = null; }

/* ── Tick ───────────────────────────────────────────────────────────── */
function tick() {
  const now = Date.now();
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
  $track.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e, null); });

  document.addEventListener('click', e => {
    if (!$ctxMenu.contains(e.target)) hideCtxMenu();
    if (!$exportMenu.contains(e.target) && e.target !== $exportBtn) $exportMenu.classList.add('hidden');
    if (selectedSegId && !$editor.contains(e.target) && !$track.contains(e.target)) deselect();
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 'c' || e.key === 'C' || e.key === ' ') { e.preventDefault(); cut(); }
    if (e.key === 'Escape') { deselect(); hideCtxMenu(); }
  });

  setInterval(tick, TICK_MS);
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
  toast('Segments merged');
}

init();
