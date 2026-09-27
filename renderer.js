'use strict';

/* ============================================================
 * 番茄钟 - 渲染进程逻辑
 * 功能：北京时间 / 学习·休息倒计时自动切换 / 今日累计 / 待办 / 设置 / 音频
 *       + 无边框窗口控制（置顶/固定位置/最小化/关闭）与折叠区块
 * ============================================================ */

const $ = (id) => document.getElementById(id);
const TOMATO = window.tomato || null; // Electron 注入的桥接对象（浏览器预览时为 null）

/* ---------- 工具函数 ---------- */

// 北京时间（固定 Asia/Shanghai 时区，不受系统时区影响）
function beijingNow() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
}

function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h} 小时 ${mm} 分钟` : `${m} 分钟`;
}

// 以每天 6:00 为界的"日键"
function dayKey() {
  const d = new Date(Date.now() - 6 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const lsGet = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (e) { return fb; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/* ---------- 设置 ---------- */

const DEFAULT_SETTINGS = {
  studyHours: 0, studyMinutes: 25,
  breakHours: 0, breakMinutes: 5,
  clockSize: 88, studySize: 64, breakSize: 64,
  volume: 70,
  audioA: null, audioB: null
};

let settings = Object.assign({}, DEFAULT_SETTINGS, lsGet('tomato-settings', {}));

function saveSettings() {
  lsSet('tomato-settings', {
    studyHours: settings.studyHours, studyMinutes: settings.studyMinutes,
    breakHours: settings.breakHours, breakMinutes: settings.breakMinutes,
    clockSize: settings.clockSize, studySize: settings.studySize, breakSize: settings.breakSize,
    volume: settings.volume,
    audioA: settings.audioA ? { path: settings.audioA.path, name: settings.audioA.name } : null,
    audioB: settings.audioB ? { path: settings.audioB.path, name: settings.audioB.name } : null
  });
}

const studyMs = () => (settings.studyHours * 3600 + settings.studyMinutes * 60) * 1000;
const breakMs = () => (settings.breakHours * 3600 + settings.breakMinutes * 60) * 1000;
const currentDurationMs = () => (state.phase === 'study' ? studyMs() : breakMs());

/* ---------- 计时状态 ---------- */

const state = {
  phase: 'study',        // 'study' | 'break'
  mode: 'pomodoro',      // 'pomodoro' 倒计时 | 'continuous' 连续学习（无倒计时）
  running: false,
  endTime: null,         // 运行中的结束时间戳（仅番茄钟模式）
  remaining: 0,          // 非运行时的剩余毫秒（暂停/待开始）
  studyRunStart: null,   // 当前学习运行段的开始时间（用于累计实际学习时长）
  contAccum: 0,          // 连续学习已累计毫秒（暂停时冻结）
  contRunStart: null     // 连续学习当前运行段开始时间
};

// 连续学习已进行的总时长 = 已冻结部分 + 正在进行的段落
function continuousElapsed() {
  let ms = state.contAccum;
  if (state.running && state.contRunStart != null) ms += Date.now() - state.contRunStart;
  return ms;
}

const isContinuous = () => state.mode === 'continuous';

function saveState() {
  lsSet('tomato-state', {
    phase: state.phase,
    running: state.running,
    endTime: state.endTime,
    remaining: state.remaining,
    studyRunStart: state.studyRunStart
  });
}

// 关闭应用 = 停止计时：把进行中的学习段并入「本次学习」，
// 主进程会在窗口真正关闭前自动把 >=1 分钟的部分写入记录，避免数据丢失。
function finalizeOnClose() {
  addStudySegment(Date.now());
  state.running = false;
  state.endTime = null;
  state.remaining = currentDurationMs();
  state.studyRunStart = null;
  saveState();
}
window.addEventListener('beforeunload', finalizeOnClose);

/* ---------- 今日数据（待办每天 6:00 归零；学习累计由「记录」驱动） ---------- */

let dayState = lsGet('tomato-day', { key: '', studyMs: 0 });
let todos = lsGet('tomato-todos', []);

function checkDay() {
  const k = dayKey();
  if (dayState.key !== k) {
    dayState = { key: k, studyMs: 0 };
    lsSet('tomato-day', dayState);
    todos = [];
    lsSet('tomato-todos', todos);
    if (state.running && state.phase === 'study') state.studyRunStart = Date.now();
    renderTodos();
    tick();
  }
}

/* ---------- 学习记录（本次学习 / 今日累计 / 历史日历） ---------- */

let sessionPendingMs = 0; // 本次学习已累计、尚未点击「记录」的时间
let records = [];         // [{date:'YYYY-MM-DD', minutes}]，来自本地 Excel

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 本次学习时间 = 已累计未入账 + 正在进行的学习段
function sessionMs() {
  let ms = sessionPendingMs;
  if (state.running && state.phase === 'study' && state.studyRunStart != null) {
    ms += Date.now() - state.studyRunStart;
  }
  return ms;
}

// 今日累计 = 今天所有记录之和
function todayRecordedMs() {
  const t = todayStr();
  return records.filter((r) => r.date === t).reduce((s, r) => s + r.minutes * 60000, 0);
}

// 点击「记录」：本次学习时间写入 Excel 并计入今日累计，然后清零
function recordSession() {
  const ms = sessionMs();
  if (ms < 60000) {
    els.recordHint.textContent = '本次学习不足 1 分钟，暂不记录';
    return;
  }
  if (!TOMATO) return;
  const minutes = Math.max(1, Math.round(ms / 60000));
  els.btnRecord.disabled = true;
  TOMATO.recordStudy(todayStr(), minutes).then((recs) => {
    els.btnRecord.disabled = false;
    if (recs == null) {
      els.recordHint.textContent = '写入失败：学习记录.xlsx 可能正被 Excel 打开，请关闭后重试';
      return;
    }
    records = recs;
    sessionPendingMs = 0;   // 已入账，清零；进行中的学习段从此刻重新开始累计
    state.studyRunStart = state.running && state.phase === 'study' ? Date.now() : null;
    saveState();
    tick();
    renderCalendar();
    els.recordHint.textContent = `已记录 ${minutes} 分钟`;
  });
}

let calYear = null;
let calMonth = null;

function fmtMin(mins) {
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}时${m}分` : `${h}小时`;
  }
  return `${mins}分`;
}

function renderCalendar() {
  if (!els.calendar) return;
  const now = new Date();
  if (calYear == null) { calYear = now.getFullYear(); calMonth = now.getMonth() + 1; }

  els.calTitle.textContent = `${calYear}年${calMonth}月`;

  // 按日期汇总
  const totals = {};
  records.forEach((r) => { totals[r.date] = (totals[r.date] || 0) + r.minutes; });

  const firstDow = (new Date(calYear, calMonth - 1, 1).getDay() + 6) % 7; // 周一 = 0
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const todayKey = todayStr();
  const mm = String(calMonth).padStart(2, '0');

  let html = '<div class="cal-week"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>';
  html += '<div class="cal-grid">';
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-cell"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${calYear}-${mm}-${String(d).padStart(2, '0')}`;
    const mins = totals[key];
    const isToday = key === todayKey;
    html += `<div class="cal-cell${isToday ? ' today' : ''}${mins ? ' has' : ''}">
      <span class="cal-day">${d}</span>
      ${mins ? `<span class="cal-mins">${fmtMin(mins)}</span>` : ''}
    </div>`;
  }
  html += '</div>';
  els.calendar.innerHTML = html;

  const prefix = `${calYear}-${mm}`;
  const monthTotal = records.filter((r) => r.date.startsWith(prefix)).reduce((s, r) => s + r.minutes, 0);
  els.monthTotal.textContent = monthTotal > 0 ? `本月合计 ${fmtMin(monthTotal)}` : '本月暂无记录';
}

// 启动时加载记录 + 迁移旧版自动累计（写进今天的第一条记录，避免数据丢失）
async function initRecords() {
  if (!TOMATO) return;
  const file = await TOMATO.getRecordFile().catch(() => null);
  if (file && els.recordFileHint) els.recordFileHint.textContent = `记录文件：${file}`;

  records = (await TOMATO.readRecords().catch(() => [])) || [];

  const old = dayState.studyMs || 0;
  if (old > 0 && !records.some((r) => r.date === todayStr())) {
    const minutes = Math.max(1, Math.round(old / 60000));
    const recs = await TOMATO.recordStudy(todayStr(), minutes).catch(() => null);
    if (recs) records = recs;
  }
  dayState.studyMs = 0;
  lsSet('tomato-day', dayState);
  renderCalendar();
}

// 供主进程在窗口关闭前查询未记录的本次学习时间（自动入账）
window.__getPendingMs = () => sessionMs();

/* ---------- 待办 ---------- */

const els = {
  clock: $('clock'),
  phaseBadge: $('phaseBadge'),
  phaseNote: $('phaseNote'),
  countdown: $('countdown'),
  progressBar: $('progressBar'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnSwitch: $('btnSwitch'),
  todayStat: $('todayStat'),
  todoInput: $('todoInput'),
  todoAdd: $('todoAdd'),
  todoList: $('todoList'),
  todoHint: $('todoHint'),
  studyH: $('studyH'), studyM: $('studyM'),
  breakH: $('breakH'), breakM: $('breakM'),
  clockSize: $('clockSize'), clockSizeVal: $('clockSizeVal'),
  studySize: $('studySize'), studySizeVal: $('studySizeVal'),
  breakSize: $('breakSize'), breakSizeVal: $('breakSizeVal'),
  volume: $('volume'), volumeVal: $('volumeVal'),
  btnAudioA: $('btnAudioA'), btnAudioB: $('btnAudioB'),
  btnPlayA: $('btnPlayA'), btnPlayB: $('btnPlayB'),
  audioAName: $('audioAName'), audioBName: $('audioBName'),
  autoLaunch: $('autoLaunch'),
  // 记录面板
  btnRecord: $('btnRecord'),
  sessionTime: $('sessionTime'),
  recordHint: $('recordHint'),
  calendar: $('calendar'),
  calTitle: $('calTitle'),
  calPrev: $('calPrev'),
  calNext: $('calNext'),
  calToday: $('calToday'),
  monthTotal: $('monthTotal'),
  recordFileHint: $('recordFileHint'),
  chipContinuous: $('chipContinuous')
};

function renderTodos() {
  els.todoList.innerHTML = '';
  if (todos.length === 0) {
    const li = document.createElement('li');
    li.className = 'todo-empty';
    li.textContent = '暂无待办';
    els.todoList.appendChild(li);
  }
  todos.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'todo-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!t.done;
    cb.addEventListener('change', () => { toggleTodo(t.id); });

    const span = document.createElement('span');
    span.className = 'todo-text' + (t.done ? ' done' : '');
    span.textContent = t.text;

    const del = document.createElement('button');
    del.className = 'todo-del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => { removeTodo(t.id); });

    li.appendChild(cb);
    li.appendChild(span);
    li.appendChild(del);
    els.todoList.appendChild(li);
  });

  const full = todos.length >= 4;
  els.todoInput.disabled = full;
  els.todoAdd.disabled = full;
  els.todoHint.textContent = full ? '最多 4 项，已满' : '每日 6:00 自动清除 · 最多 4 项';
}

function addTodo() {
  const text = els.todoInput.value.trim();
  if (!text || todos.length >= 4) return;
  todos.push({ id: Date.now() + Math.random(), text, done: false });
  els.todoInput.value = '';
  lsSet('tomato-todos', todos);
  renderTodos();
}

function toggleTodo(id) {
  const t = todos.find((x) => x.id === id);
  if (t) { t.done = !t.done; lsSet('tomato-todos', todos); renderTodos(); }
}

function removeTodo(id) {
  todos = todos.filter((x) => x.id !== id);
  lsSet('tomato-todos', todos);
  renderTodos();
}

/* ---------- 音频 ---------- */

const audioCache = {};    // path -> dataUrl | null
const audioPromise = {};  // path -> Promise（并发加载去重）
const audioEls = {};      // key -> Audio 元素（每种提示音只保留一个实例，避免叠加播放）

function ensureAudio(key) {
  const item = settings[key];
  if (!item) return Promise.resolve(null);
  if (key in audioCache) return Promise.resolve(audioCache[key]);
  if (audioPromise[key]) return audioPromise[key];
  if (!TOMATO) return Promise.resolve(null);
  audioPromise[key] = TOMATO.loadAudio(item.path).then((res) => {
    audioCache[key] = res && res.dataUrl ? res.dataUrl : null;
    if (res && !res.dataUrl) markAudioUnavailable(key);
    return audioCache[key];
  }).catch(() => { audioCache[key] = null; return null; });
  return audioPromise[key];
}

const previewBtn = (key) => (key === 'audioA' ? els.btnPlayA : els.btnPlayB);

// 播放提示音：复用同一 Audio 实例、从头播放（同时只会有一种声音）
function playSound(key) {
  ensureAudio(key).then((dataUrl) => {
    if (!dataUrl) return;
    let a = audioEls[key];
    if (!a) {
      a = new Audio();
      audioEls[key] = a;
      const btn = previewBtn(key);
      const resetBtn = () => { if (btn) btn.textContent = '试听'; };
      a.addEventListener('ended', resetBtn); // 播完自动复位
      a.addEventListener('pause', resetBtn); // 手动暂停复位
    }
    a.src = dataUrl;
    a.volume = Math.min(1, Math.max(0, settings.volume / 100));
    a.currentTime = 0;
    a.play().catch(() => {});
    const btn = previewBtn(key);
    if (btn) btn.textContent = '停止';
  });
}

// 试听开关：播放中点一下即暂停，再点从头播放；同一时间只试听一个
function togglePreview(key) {
  const a = audioEls[key];
  if (a && a.src && !a.paused) {
    a.pause();
    return;
  }
  const other = key === 'audioA' ? 'audioB' : 'audioA';
  const otherEl = audioEls[other];
  if (otherEl && !otherEl.paused) otherEl.pause();
  playSound(key);
}

function markAudioUnavailable(key) {
  const nameEl = key === 'audioA' ? els.audioAName : els.audioBName;
  nameEl.textContent = '（文件不可用，请重新选择）';
  nameEl.classList.add('error');
}

function updateAudioRow(key) {
  const item = settings[key];
  const nameEl = key === 'audioA' ? els.audioAName : els.audioBName;
  nameEl.classList.remove('error');
  if (!item) { nameEl.textContent = '未设置'; return; }
  if (audioCache[key] == null && key in audioCache) {
    nameEl.textContent = '（文件不可用，请重新选择）';
    nameEl.classList.add('error');
  } else {
    nameEl.textContent = item.name;
  }
}

function pickAudio(key) {
  if (!TOMATO) { alert('音频选择仅在桌面版可用'); return; }
  TOMATO.selectAudio().then((res) => {
    if (!res) return;
    settings[key] = { path: res.path, name: res.name };
    audioCache[key] = res.dataUrl;
    audioPromise[key] = null;          // 换了文件，旧加载结果作废
    saveSettings();
    updateAudioRow(key);
  });
}

/* ---------- 阶段与界面 ---------- */

function updatePhaseUI() {
  const cont = isContinuous();
  const isStudy = state.phase === 'study';
  document.body.classList.toggle('phase-study', isStudy);
  document.body.classList.toggle('phase-break', !isStudy);
  document.body.classList.toggle('mode-continuous', cont);
  if (els.chipContinuous) els.chipContinuous.classList.toggle('active', cont);

  els.phaseBadge.textContent = cont ? '连续学习' : (isStudy ? '学习' : '休息');
  els.countdown.style.fontSize = (isStudy ? settings.studySize : settings.breakSize) + 'px';

  if (cont) {
    els.phaseNote.textContent = state.running ? '不间断进行中' : '已暂停';
    els.btnStart.textContent = state.running ? '暂停' : '继续';
    els.btnStop.textContent = '结束';
    return;
  }

  els.btnStop.textContent = '停止';
  const total = currentDurationMs();
  const note = state.running
    ? (isStudy ? '专注中' : '休息中')
    : (state.remaining < total - 500 ? '已暂停' : '待开始');
  els.phaseNote.textContent = note;

  els.btnStart.textContent = state.running ? '暂停' : (state.remaining < total - 500 ? '继续' : '开始');
}

function tick() {
  // 时钟（秒变化时才重新格式化，避免每帧重复 Intl 开销）
  const now = Date.now();
  const secKey = Math.floor(now / 1000);
  if (secKey !== tick.lastSec) {
    tick.lastSec = secKey;
    els.clock.textContent = beijingNow();
  }

  if (isContinuous()) {
    // 连续学习：正计时，永不结束
    els.countdown.textContent = fmtCountdown(continuousElapsed());
  } else {
    if (state.running && state.endTime != null) {
      state.remaining = state.endTime - now;
      if (state.remaining <= 0) { completePhase(); return; }
    }

    els.countdown.textContent = fmtCountdown(state.remaining);

    const total = currentDurationMs();
    const pct = total > 0 ? Math.min(100, Math.max(0, (1 - state.remaining / total) * 100)) : 0;
    els.progressBar.style.width = pct + '%';
  }

  els.todayStat.textContent = fmtDuration(todayRecordedMs());
  if (els.sessionTime) els.sessionTime.textContent = fmtDuration(sessionMs());

  updatePhaseUI();
}
tick.lastSec = 0;

/* ---------- 计时控制 ---------- */

// 纯连续学习模式：无倒计时，正计时一直累计；时间照常进「本次学习」，可点「记录」入账
function enterContinuous() {
  if (isContinuous()) return;
  const now = Date.now();
  addStudySegment(now);        // 若番茄钟学习段正在跑，先并入本次学习，避免丢失
  state.mode = 'continuous';
  state.phase = 'study';
  state.running = true;
  state.endTime = null;
  state.remaining = 0;
  state.contAccum = 0;
  state.contRunStart = now;
  state.studyRunStart = now;   // 连续学习时间同样计入「本次学习」
  saveState();
  tick();
}

// 结束连续学习：时间保留在「本次学习」里，回到普通番茄钟待开始状态
function exitContinuous() {
  if (!isContinuous()) return;
  addStudySegment(Date.now());
  state.mode = 'pomodoro';
  state.running = false;
  state.endTime = null;
  state.contAccum = 0;
  state.contRunStart = null;
  state.remaining = currentDurationMs();
  saveState();
  tick();
}

function toggleContinuous() {
  if (isContinuous()) exitContinuous();
  else enterContinuous();
}

function start() {
  if (state.running) return;
  if (isContinuous()) {
    const now = Date.now();
    state.contRunStart = now;
    state.running = true;
    if (state.studyRunStart == null) state.studyRunStart = now;
    saveState();
    tick();
    return;
  }
  state.remaining = Math.max(1000, state.remaining);
  state.endTime = Date.now() + state.remaining;
  state.running = true;
  if (state.phase === 'study' && state.studyRunStart == null) state.studyRunStart = Date.now();
  saveState();
  tick();
}

function pause() {
  if (!state.running) return;
  if (isContinuous()) {
    const now = Date.now();
    if (state.contRunStart != null) {
      state.contAccum += now - state.contRunStart;
      state.contRunStart = null;
    }
    state.running = false;
    addStudySegment(now);
    saveState();
    tick();
    return;
  }
  state.remaining = Math.max(0, state.endTime - Date.now());
  state.running = false;
  state.endTime = null;
  addStudySegment(Date.now());
  saveState();
  tick();
}

function stop() {
  if (isContinuous()) { exitContinuous(); return; }   // 连续模式下「停止」= 结束连续学习
  addStudySegment(Date.now());
  state.running = false;
  state.endTime = null;
  state.remaining = currentDurationMs();
  saveState();
  tick();
}

// 手动切换（不播放提示音）；连续学习模式没有休息阶段
function switchPhase() {
  if (isContinuous()) return;
  addStudySegment(Date.now());
  state.phase = state.phase === 'study' ? 'break' : 'study';
  state.running = true;
  state.remaining = currentDurationMs();
  state.endTime = Date.now() + state.remaining;
  state.studyRunStart = state.phase === 'study' ? Date.now() : null;
  saveState();
  tick();
}

// 自然结束：累计学习时长、播放提示音、自动切换到下一阶段
function completePhase() {
  const now = Date.now();
  const wasStudy = state.phase === 'study';

  if (wasStudy) {
    addStudySegment(now);
    playSound('audioA');
  } else {
    playSound('audioB');
  }

  state.phase = wasStudy ? 'break' : 'study';
  state.remaining = currentDurationMs();
  state.endTime = now + state.remaining;
  state.running = true;
  state.studyRunStart = state.phase === 'study' ? now : null;
  saveState();
  tick();
}

// 把当前进行中的学习段累计到「本次学习」（未记录）
function addStudySegment(now) {
  if (state.studyRunStart != null) {
    sessionPendingMs += now - state.studyRunStart;
    state.studyRunStart = null;
  }
}

/* ---------- 恢复状态 ---------- */

// 关闭即停止：每次启动都从"待开始"状态开始，不延续上次的倒计时
function restoreState() {
  state.phase = 'study';
  state.mode = 'pomodoro';   // 连续学习不跨重启，每次打开都从普通模式开始
  state.running = false;
  state.endTime = null;
  state.remaining = currentDurationMs();
  state.studyRunStart = null;
  state.contAccum = 0;
  state.contRunStart = null;
}

/* ---------- 设置界面 ---------- */

function clampInt(v, min, max) { return Math.min(max, Math.max(min, Math.round(v || 0))); }

function syncDurationInputs() {
  els.studyH.value = settings.studyHours;
  els.studyM.value = settings.studyMinutes;
  els.breakH.value = settings.breakHours;
  els.breakM.value = settings.breakMinutes;
}

function applyDurationChange() {
  if (!state.running) {
    state.remaining = currentDurationMs();
    saveState();
  }
  tick();
}

function bindDurationInput(inputEl, key, max) {
  inputEl.addEventListener('change', () => {
    settings[key] = clampInt(parseInt(inputEl.value, 10) || 0, 0, max);
    inputEl.value = settings[key];
    saveSettings();
    applyDurationChange();
  });
}

const STEP_MAP = {
  studyHMinus: ['studyHours', -1], studyHPlus: ['studyHours', 1],
  studyMMinus: ['studyMinutes', -1], studyMPlus: ['studyMinutes', 1],
  breakHMinus: ['breakHours', -1], breakHPlus: ['breakHours', 1],
  breakMMinus: ['breakMinutes', -1], breakMPlus: ['breakMinutes', 1]
};

document.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const [key, delta] = STEP_MAP[btn.dataset.act];
    const max = key.endsWith('Hours') ? 23 : 60;
    settings[key] = clampInt(settings[key] + delta, 0, max);
    saveSettings();
    syncDurationInputs();
    applyDurationChange();
  });
});

function bindSlider(sliderEl, valEl, key, suffix, apply) {
  sliderEl.value = settings[key];
  const refresh = () => {
    valEl.textContent = settings[key] + suffix;
    sliderEl.value = settings[key];
  };
  refresh();
  sliderEl.addEventListener('input', () => {
    settings[key] = parseInt(sliderEl.value, 10) || 0;
    refresh();
    saveSettings();
    if (apply) apply();
    autoResize(); // 字号/音量变化后窗口高度可能变化
  });
}

function initSettingsUI() {
  syncDurationInputs();
  bindDurationInput(els.studyH, 'studyHours', 23);
  bindDurationInput(els.studyM, 'studyMinutes', 60);
  bindDurationInput(els.breakH, 'breakHours', 23);
  bindDurationInput(els.breakM, 'breakMinutes', 60);

  bindSlider(els.clockSize, els.clockSizeVal, 'clockSize', 'px', () => {
    els.clock.style.fontSize = settings.clockSize + 'px';
  });
  bindSlider(els.studySize, els.studySizeVal, 'studySize', 'px', () => { updatePhaseUI(); });
  bindSlider(els.breakSize, els.breakSizeVal, 'breakSize', 'px', () => { updatePhaseUI(); });
  bindSlider(els.volume, els.volumeVal, 'volume', '%', () => {});

  els.clock.style.fontSize = settings.clockSize + 'px';

  els.btnAudioA.addEventListener('click', () => pickAudio('audioA'));
  els.btnAudioB.addEventListener('click', () => pickAudio('audioB'));
  els.btnPlayA.addEventListener('click', () => togglePreview('audioA'));
  els.btnPlayB.addEventListener('click', () => togglePreview('audioB'));

  // 开机自启动：启动时回读真实状态，切换后回读确认
  if (TOMATO) {
    TOMATO.getAutoLaunch().then((v) => { els.autoLaunch.checked = !!v; });
    els.autoLaunch.addEventListener('change', () => {
      TOMATO.setAutoLaunch(els.autoLaunch.checked).then((v) => {
        els.autoLaunch.checked = !!v; // 以系统实际写入结果为准
      });
    });
  }
}

/* ---------- 无边框窗口控制 ---------- */

const btnTop = $('btnTop');
const btnLock = $('btnLock');
const btnMin = $('btnMin');
const btnClose = $('btnClose');

// 点击反馈：让按钮旋转一圈（通过移除/重排/添加让动画每次点击都能重新触发）
function spinButton(btn) {
  if (!btn) return;
  btn.classList.remove('spin');
  void btn.offsetWidth; // 强制重排，重置动画
  btn.classList.add('spin');
}

btnMin.addEventListener('click', () => TOMATO && TOMATO.minimize());
btnClose.addEventListener('click', () => TOMATO && TOMATO.close());
btnTop.addEventListener('click', () => { spinButton(btnTop); TOMATO && TOMATO.toggleTop(); });
btnLock.addEventListener('click', () => { spinButton(btnLock); TOMATO && TOMATO.toggleLock(); });

// 主进程同步置顶/锁定状态，用于按钮高亮
if (TOMATO) {
  TOMATO.onWindowState((s) => {
    btnTop.classList.toggle('active', !!s.alwaysOnTop);
    btnTop.title = s.alwaysOnTop ? '取消置顶' : '置顶';
    btnLock.classList.toggle('active', !!s.locked);
    btnLock.textContent = s.locked ? '🔒' : '🔓';
    btnLock.title = s.locked ? '解除固定（可拖动）' : '固定当前位置';
  });
}

/* ---------- 折叠区块：统计 / 待办 / 设置 ---------- */

// 按内容高度自适应窗口大小（展开/收起、字号变化时调用）
let autoResizeTimer = null;
function autoResize() {
  if (!TOMATO) return;
  clearTimeout(autoResizeTimer);
  autoResizeTimer = setTimeout(() => {
    const main = document.querySelector('main');
    if (!main) return;
    // 用 main 的实际底部位置计算内容高度。
    // 注意：scrollHeight 在"内容比窗口矮"时返回的是视口高度，无法让窗口缩小。
    const h = Math.ceil(main.getBoundingClientRect().bottom + window.scrollY) + 2;
    TOMATO.resizeTo(window.innerWidth, h);
  }, 80);
}

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const card = document.getElementById(chip.dataset.target);
    if (!card) return;
    const willShow = card.hidden;
    card.hidden = !willShow;               // 点击显示，再点隐藏
    chip.classList.toggle('active', willShow);
    autoResize();
  });
});

/* ---------- 事件绑定 ---------- */

els.btnStart.addEventListener('click', () => (state.running ? pause() : start()));
els.btnStop.addEventListener('click', stop);
els.btnSwitch.addEventListener('click', switchPhase);
els.chipContinuous.addEventListener('click', toggleContinuous);

els.todoAdd.addEventListener('click', addTodo);
els.todoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });

/* 记录：按钮 + 日历翻页 */
els.btnRecord.addEventListener('click', recordSession);
els.calPrev.addEventListener('click', () => {
  calMonth--;
  if (calMonth < 1) { calMonth = 12; calYear--; }
  renderCalendar();
});
els.calNext.addEventListener('click', () => {
  calMonth++;
  if (calMonth > 12) { calMonth = 1; calYear++; }
  renderCalendar();
});
els.calToday.addEventListener('click', () => {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;
  renderCalendar();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); checkDay(); } });

/* ---------- 启动 ---------- */

// 先恢复运行状态，再检查跨天（6:00），避免把昨天进行中的学习段计入今天
restoreState();
checkDay();
initSettingsUI();
renderTodos();
saveState();
initRecords();   // 加载 Excel 记录 + 旧数据迁移 + 渲染日历（异步）
tick();
setInterval(tick, 200);
setInterval(checkDay, 60000);

// 首帧后按内容收缩窗口（默认只显示时钟与倒计时两个模块）
autoResize();

// 预加载音频（应用启动时读取，失败则标记不可用）
['audioA', 'audioB'].forEach((key) => {
  if (settings[key]) {
    ensureAudio(key).then(() => updateAudioRow(key));
  } else {
    updateAudioRow(key);
  }
});
