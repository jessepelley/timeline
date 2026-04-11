'use strict';

/* ── Constants ──────────────────────────────────────────────────────── */
const SHIFT_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours
const STORAGE_KEY = 'shift-timeline-v2';
const CATEGORIES = ['Work', 'Meeting', 'Break', 'Interruption', 'Admin'];
const TICK_INTERVAL_MS = 1000; // redraw every second
const LARGE_UNALLOCATED_THRESHOLD_MS = 30 * 60 * 1000; // warn after 30 min unallocated

/* ── Utilities ──────────────────────────────────────────────────────── */
function snap(ms) {
  const halfHour = 30 * 60 * 1000;
  return Math.round(ms / halfHour) * halfHour;
}

function formatTime(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = ((h % 12) || 12);
  return `${h12}:${m}${suffix}`;
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDurationShort(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}`;
  return `${m}:${String(totalSec % 60).padStart(2,'0')}`;
}

function catClass(label) {
  if (!label || label === 'Unallocated') return 'seg-unallocated';
  const known = ['work','meeting','break','interruption','admin'];
  const low = label.toLowerCase();
  if (known.includes(low)) return `seg-${low}`;
  return 'seg-custom';
}

function catColor(label) {
  const map = {
    'Unallocated': 'var(--col-unallocated)',
    'Work':        'var(--col-work)',
    'Meeting':     'var(--col-meeting)',
    'Break':       'var(--col-break)',
    'Interruption':'var(--col-interruption)',
    'Admin':       'var(--col-admin)',
  };
  return map[label] || 'var(--col-custom)';
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

/* ── State ──────────────────────────────────────────────────────────── */
let state = {
  shiftStart: 0,
  shiftEnd: 0,
  segments: [], // { id, start, end|null, label }
};

let selectedSegId = null;
let tooltipEl = null;

/* ── Persistence ────────────────────────────────────────────────────── */
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.shiftStart || !Array.isArray(parsed.segments)) return false;
    state = parsed;
    return true;
  } catch { return false; }
}

/* ── Shift initialisation ───────────────────────────────────────────── */
function initShift() {
  const now = Date.now();
  const snapped = snap(now);
  state.shiftStart = snapped;
  state.shiftEnd = snapped + SHIFT_DURATION_MS;
  state.segments = [{ id: generateId(), start: snapped, end: null, label: null }];
  saveState();
}

function isShiftExpired() {
  return Date.now() > state.shiftEnd + (60 * 60 * 1000); // 1hr grace
}

/* ── DOM references ─────────────────────────────────────────────────── */
const $shiftTimeRange  = document.getElementById('shift-time-range');
const $timeRuler       = document.getElementById('time-ruler');
const $timelineTrack   = document.getElementById('timeline-track');
const $segmentsContainer = document.getElementById('segments-container');
const $playhead        = document.getElementById('playhead');
const $futureOverlay   = document.getElementById('future-overlay');
const $editorPanel     = document.getElementById('editor-panel');
const $editorSegTime   = document.getElementById('editor-seg-time');
const $editorClose     = document.getElementById('editor-close');
const $categoryChips   = document.getElementById('category-chips');
const $customLabelInput= document.getElementById('custom-label-input');
const $customLabelBtn  = document.getElementById('custom-label-btn');
const $splitHalvesBtn  = document.getElementById('split-halves-btn');
const $splitNBtn       = document.getElementById('split-n-btn');
const $cutBtn          = document.getElementById('cut-btn');
const $resetBtn        = document.getElementById('reset-btn');
const $themeBtn        = document.getElementById('theme-btn');
const $toastContainer  = document.getElementById('toast-container');

const $statAllocated    = document.getElementById('stat-allocated');
const $statUnallocated  = document.getElementById('stat-unallocated');
const $statSegments     = document.getElementById('stat-segments');
const $statInterruptions= document.getElementById('stat-interruptions');
const $statLongest      = document.getElementById('stat-longest');
const $statAvg          = document.getElementById('stat-avg');

/* ── Toast ──────────────────────────────────────────────────────────── */
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ── Tooltip ────────────────────────────────────────────────────────── */
function ensureTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'seg-tooltip';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

/* ── Cut action ─────────────────────────────────────────────────────── */
function cut() {
  const now = Date.now();
  if (now >= state.shiftEnd) { toast('Shift has ended.'); return; }
  if (now <= state.shiftStart) { toast('Shift has not started yet.'); return; }

  const openSeg = state.segments.find(s => s.end === null);
  if (!openSeg) return;

  // don't cut within 3 seconds of last cut
  const lastClosed = [...state.segments]
    .filter(s => s.end !== null)
    .sort((a,b) => b.end - a.end)[0];
  if (lastClosed && now - lastClosed.end < 3000) {
    toast('Too soon — wait a moment before cutting again.');
    return;
  }

  openSeg.end = now;
  state.segments.push({ id: generateId(), start: now, end: null, label: null });
  saveState();
  renderTimeline();
  renderStats();
  checkUnallocatedWarning();
  animateCut();
}

function animateCut() {
  $cutBtn.style.transform = 'scale(.92)';
  setTimeout(() => { $cutBtn.style.transform = ''; }, 150);
}

/* ── Segment selection & editing ────────────────────────────────────── */
function selectSegment(id) {
  selectedSegId = id;
  renderTimeline(); // update selection highlight
  openEditor();
}

function deselectSegment() {
  selectedSegId = null;
  renderTimeline();
  closeEditor();
}

function openEditor() {
  const seg = state.segments.find(s => s.id === selectedSegId);
  if (!seg) return;

  const now = Date.now();
  const effectiveEnd = seg.end || Math.min(now, state.shiftEnd);
  const dur = effectiveEnd - seg.start;

  $editorSegTime.textContent =
    `${formatTime(seg.start)} – ${seg.end ? formatTime(seg.end) : 'now'} · ${formatDuration(dur)}`;

  // build chips
  $categoryChips.innerHTML = '';
  const allCats = ['Unallocated', ...CATEGORIES];
  allCats.forEach(cat => {
    const chip = document.createElement('span');
    chip.className = 'chip' + ((!seg.label && cat === 'Unallocated') || seg.label === cat ? ' active' : '');
    chip.dataset.cat = cat;
    chip.textContent = cat;
    chip.style.background = catColor(cat);
    chip.addEventListener('click', () => {
      applyLabel(cat === 'Unallocated' ? null : cat);
    });
    $categoryChips.appendChild(chip);
  });

  // if custom label show it
  if (seg.label && !CATEGORIES.includes(seg.label) && seg.label !== 'Unallocated') {
    $customLabelInput.value = seg.label;
  } else {
    $customLabelInput.value = '';
  }

  $editorPanel.classList.remove('hidden');
}

function closeEditor() {
  $editorPanel.classList.add('hidden');
}

function applyLabel(label) {
  const seg = state.segments.find(s => s.id === selectedSegId);
  if (!seg) return;
  seg.label = label;
  saveState();
  renderTimeline();
  renderStats();
  openEditor(); // refresh chips
  toast(label ? `Labeled: ${label}` : 'Marked as Unallocated');
}

/* ── Splitting ──────────────────────────────────────────────────────── */
function splitSegmentInto(id, n) {
  const idx = state.segments.findIndex(s => s.id === id);
  if (idx === -1) return;
  const seg = state.segments[idx];

  const now = Date.now();
  const effectiveEnd = seg.end || Math.min(now, state.shiftEnd);
  if (effectiveEnd <= seg.start) return;
  if (n < 2) return;

  const dur = (effectiveEnd - seg.start) / n;
  const newSegs = [];
  for (let i = 0; i < n; i++) {
    newSegs.push({
      id: generateId(),
      start: seg.start + i * dur,
      end: seg.end !== null ? seg.start + (i + 1) * dur
            : i < n - 1 ? seg.start + (i + 1) * dur : null,
      label: null,
    });
  }

  state.segments.splice(idx, 1, ...newSegs);
  selectedSegId = newSegs[0].id;
  saveState();
  renderTimeline();
  renderStats();
  openEditor();
  toast(`Split into ${n} segments`);
}

/* ── Stats ──────────────────────────────────────────────────────────── */
function renderStats() {
  const now = Date.now();
  const totalElapsed = Math.min(now, state.shiftEnd) - state.shiftStart;

  let allocated = 0;
  let unallocated = 0;
  let interruptions = 0;
  let longest = 0;
  let count = 0;

  state.segments.forEach(seg => {
    const end = seg.end || Math.min(now, state.shiftEnd);
    const dur = Math.max(0, end - seg.start);
    count++;
    if (!seg.label) {
      unallocated += dur;
    } else {
      allocated += dur;
      if (seg.label === 'Interruption') interruptions++;
      if (dur > longest) longest = dur;
    }
  });

  const avg = count > 0 ? totalElapsed / count : 0;

  $statAllocated.textContent    = formatDurationShort(allocated);
  $statUnallocated.textContent  = formatDurationShort(unallocated);
  $statSegments.textContent     = count;
  $statInterruptions.textContent= interruptions;
  $statLongest.textContent      = longest > 0 ? formatDurationShort(longest) : '—';
  $statAvg.textContent          = formatDurationShort(avg);
}

/* ── Unallocated warning ────────────────────────────────────────────── */
let bannerEl = null;

function checkUnallocatedWarning() {
  const now = Date.now();
  const openSeg = state.segments.find(s => s.end === null);
  if (!openSeg || openSeg.label) {
    hideBanner();
    return;
  }
  const dur = now - openSeg.start;
  if (dur >= LARGE_UNALLOCATED_THRESHOLD_MS) {
    showBanner(openSeg, dur);
  } else {
    hideBanner();
  }
}

function showBanner(seg, dur) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.id = 'unallocated-banner';
    bannerEl.innerHTML = `<span></span><button>Split or label</button>`;
    bannerEl.querySelector('button').addEventListener('click', () => {
      selectSegment(seg.id);
      hideBanner();
    });
    // insert after stats panel
    const stats = document.getElementById('stats-panel');
    stats.insertAdjacentElement('afterend', bannerEl);
  }
  bannerEl.querySelector('span').textContent =
    `Large unallocated block: ${formatDuration(dur)} unlabeled`;
  bannerEl.classList.remove('hidden');
}

function hideBanner() {
  if (bannerEl) bannerEl.classList.add('hidden');
}

/* ── Timeline rendering ─────────────────────────────────────────────── */
function renderRuler() {
  $timeRuler.innerHTML = '';
  const trackW = $timelineTrack.offsetWidth;
  if (!trackW) return;

  const total = SHIFT_DURATION_MS;
  const stepMs = 30 * 60 * 1000; // 30-min ticks

  for (let t = 0; t <= total; t += stepMs) {
    const pct = t / total;
    const tick = document.createElement('div');
    tick.className = 'ruler-tick' + (t % (60 * 60 * 1000) === 0 ? ' major' : '');
    tick.style.left = (pct * 100) + '%';
    tick.textContent = formatTime(state.shiftStart + t);
    $timeRuler.appendChild(tick);
  }
}

function renderTimeline() {
  const now = Date.now();
  const trackW = $timelineTrack.offsetWidth;
  if (!trackW) return;

  const total = SHIFT_DURATION_MS;
  const elapsed = Math.max(0, Math.min(now - state.shiftStart, total));
  const playheadPct = elapsed / total;

  // playhead
  $playhead.style.left = (playheadPct * 100) + '%';

  // future overlay
  $futureOverlay.style.left = (playheadPct * 100) + '%';
  $futureOverlay.style.right = '0';

  // shift time range label
  $shiftTimeRange.textContent = `${formatTime(state.shiftStart)} – ${formatTime(state.shiftEnd)}`;

  // clear old segment elements
  $segmentsContainer.innerHTML = '';

  state.segments.forEach(seg => {
    const segStart = Math.max(seg.start, state.shiftStart);
    const segEnd   = seg.end ? Math.min(seg.end, state.shiftEnd)
                             : Math.min(now, state.shiftEnd);

    const leftPct  = ((segStart - state.shiftStart) / total) * 100;
    const widthPct = Math.max(0, ((segEnd - segStart) / total) * 100);
    if (widthPct <= 0) return;

    const el = document.createElement('div');
    el.className = 'segment ' + catClass(seg.label);
    if (seg.id === selectedSegId) el.classList.add('selected');
    if (widthPct > 3) el.classList.add('wide'); // show label when wide enough

    el.style.left  = leftPct + '%';
    el.style.width = widthPct + '%';
    if (seg.label) el.style.background = catColor(seg.label);

    // inner label
    const labelEl = document.createElement('div');
    labelEl.className = 'segment-label';
    labelEl.textContent = seg.label || 'Unallocated';
    el.appendChild(labelEl);

    // tooltip
    el.addEventListener('mouseenter', e => {
      const tip = ensureTooltip();
      const dur = (seg.end || now) - seg.start;
      tip.textContent = `${seg.label || 'Unallocated'} · ${formatDuration(dur)} · ${formatTime(seg.start)}–${formatTime(seg.end || now)}`;
      tip.classList.add('visible');
      moveTooltip(e);
    });
    el.addEventListener('mousemove', moveTooltip);
    el.addEventListener('mouseleave', () => {
      ensureTooltip().classList.remove('visible');
    });

    el.addEventListener('click', e => {
      e.stopPropagation();
      if (seg.id === selectedSegId) {
        deselectSegment();
      } else {
        selectSegment(seg.id);
      }
    });

    $segmentsContainer.appendChild(el);
  });
}

function moveTooltip(e) {
  const tip = ensureTooltip();
  const x = e.clientX + 12;
  const y = e.clientY - 30;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}

/* ── Prompt helper ──────────────────────────────────────────────────── */
function showPrompt(labelText, defaultVal, onConfirm) {
  let overlay = document.getElementById('prompt-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'prompt-overlay';
    overlay.innerHTML = `
      <div id="prompt-box">
        <label id="prompt-label"></label>
        <input id="prompt-input" type="number" min="2" max="20" />
        <div class="prompt-buttons">
          <button id="prompt-cancel">Cancel</button>
          <button id="prompt-ok" class="primary">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }
  document.getElementById('prompt-label').textContent = labelText;
  const input = document.getElementById('prompt-input');
  input.value = defaultVal;
  overlay.classList.remove('hidden');
  input.focus();
  input.select();

  const ok = () => {
    const val = parseInt(input.value, 10);
    overlay.classList.add('hidden');
    if (val >= 2) onConfirm(val);
  };
  const cancel = () => overlay.classList.add('hidden');

  document.getElementById('prompt-ok').onclick = ok;
  document.getElementById('prompt-cancel').onclick = cancel;
  input.onkeydown = e => {
    if (e.key === 'Enter') ok();
    if (e.key === 'Escape') cancel();
  };
  overlay.onclick = e => { if (e.target === overlay) cancel(); };
}

/* ── Reset ──────────────────────────────────────────────────────────── */
function confirmReset() {
  if (!confirm('Reset the current shift? This will clear all data and start a new shift.')) return;
  localStorage.removeItem(STORAGE_KEY);
  initShift();
  selectedSegId = null;
  closeEditor();
  hideBanner();
  renderRuler();
  renderTimeline();
  renderStats();
  toast('New shift started');
}

/* ── Dark mode ──────────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem('shift-theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  localStorage.setItem('shift-theme', isDark ? 'light' : 'dark');
}

/* ── Event wiring ───────────────────────────────────────────────────── */
$cutBtn.addEventListener('click', cut);

$resetBtn.addEventListener('click', confirmReset);

$themeBtn.addEventListener('click', toggleTheme);

$editorClose.addEventListener('click', deselectSegment);

$customLabelBtn.addEventListener('click', () => {
  const val = $customLabelInput.value.trim();
  if (val) applyLabel(val);
});

$customLabelInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const val = $customLabelInput.value.trim();
    if (val) applyLabel(val);
  }
});

$splitHalvesBtn.addEventListener('click', () => {
  if (selectedSegId) splitSegmentInto(selectedSegId, 2);
});

$splitNBtn.addEventListener('click', () => {
  if (!selectedSegId) return;
  showPrompt('Split into how many equal parts?', 3, n => splitSegmentInto(selectedSegId, n));
});

// close editor on clicking outside
document.addEventListener('click', e => {
  if (selectedSegId &&
      !$editorPanel.contains(e.target) &&
      !$timelineTrack.contains(e.target)) {
    deselectSegment();
  }
});

// keyboard shortcut: C or Space = CUT
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'c' || e.key === 'C' || e.key === ' ') {
    e.preventDefault();
    cut();
  }
  if (e.key === 'Escape') deselectSegment();
});

/* ── Tick loop ──────────────────────────────────────────────────────── */
let lastWarningCheck = 0;

function tick() {
  const now = Date.now();
  renderTimeline();
  renderStats();

  // check unallocated warning every 30s
  if (now - lastWarningCheck > 30_000) {
    lastWarningCheck = now;
    checkUnallocatedWarning();
  }

  // auto-close open segment when shift ends
  const openSeg = state.segments.find(s => s.end === null);
  if (openSeg && now >= state.shiftEnd) {
    openSeg.end = state.shiftEnd;
    saveState();
    toast('Shift ended — all segments closed.');
  }
}

/* ── Init ───────────────────────────────────────────────────────────── */
function init() {
  initTheme();

  const restored = loadState();
  if (!restored || isShiftExpired()) {
    initShift();
  }

  renderRuler();
  renderTimeline();
  renderStats();

  // re-render ruler on resize
  const ro = new ResizeObserver(() => {
    renderRuler();
    renderTimeline();
  });
  ro.observe($timelineTrack);

  setInterval(tick, TICK_INTERVAL_MS);
}

init();
