import { PHASES, displayStatus, visibleSessions, planProgress, fmtDuration, hookLine, apply } from './state.js';
import { followTranscripts } from './transcript.js';
import { repoInfo } from './git.js';
import { tildify } from './paths.js';

// ── styling ─────────────────────────────────────────────────────────────────────
const useColor = !process.env.NO_COLOR;
const sgr = (open, close) => (s) => (useColor && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);
const st = {
  bold: sgr(1, 22), dim: sgr(2, 22), inverse: sgr(7, 27),
  red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), blue: sgr(34, 39),
  magenta: sgr(35, 39), cyan: sgr(36, 39), gray: sgr(90, 39), white: sgr(97, 39),
};
const both = (a, b) => (s) => a(b(s));

const STATUS = {
  approval: { mark: '◆', label: 'needs you', style: both(st.bold, st.red) },
  working: { mark: '●', label: 'working', style: st.green },
  quiet: { mark: '●', label: 'gone quiet', style: st.yellow },
  yourturn: { mark: '○', label: 'your turn', style: st.cyan },
  idle: { mark: '○', label: 'idle', style: st.gray },
  ended: { mark: '·', label: 'ended', style: st.gray },
};
const phaseStyle = (p) => {
  const phase = PHASES[p] || PHASES.other;
  const paint = st[phase.color] || st.gray;
  return phase.bold ? both(st.bold, paint) : paint;
};

// ── text measuring ──────────────────────────────────────────────────────────────
function charWidth(cp) {
  if (cp === 0x200b || cp === 0x200d || cp === 0xfe0f || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
const clean = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ');
const textWidth = (s) => { let w = 0; for (const ch of clean(s)) w += charWidth(ch.codePointAt(0)); return w; };

// Lay out styled segments into exactly `width` columns, ending in … when they don't fit.
function fit(segs, width, pad = true) {
  const parts = segs.filter(Boolean).map(([t, style]) => [clean(t), style]);
  const total = parts.reduce((n, [t]) => n + textWidth(t), 0);
  const budget = total > width ? Math.max(0, width - 1) : width;
  let out = '';
  let w = 0;
  for (const [t, style] of parts) {
    let piece = '';
    for (const ch of t) {
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw > budget) break;
      piece += ch;
      w += cw;
    }
    if (piece) out += style ? style(piece) : piece;
    if (w >= budget) break;
  }
  if (total > width && width > 0) { out += st.dim('…'); w += 1; }
  if (pad && w < width) out += ' '.repeat(width - w);
  return out;
}

function line(left, right, width) {
  if (!right || !right.length) return fit(left, width);
  const rw = right.reduce((n, [t]) => n + textWidth(t), 0);
  if (rw + 4 > width) return fit(left, width);
  return fit(left, width - rw - 1) + ' ' + fit(right, rw);
}

const ago = (ms) => (ms < 5000 ? 'now' : `${fmtDuration(ms)} ago`);
const clock = (ts) => new Date(ts).toTimeString().slice(0, 8);
const firstLine = (s) => (s ? String(s).split(/\n/)[0] : '');
// "claude-opus-4-1" and "claude-3-5-sonnet-20241022" both get to keep the part that
// says which model it is, without the vendor prefix or the build date.
const shortModel = (m) => (m ? String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '').slice(0, 12) : '');

// ── session list ────────────────────────────────────────────────────────────────
function strip(s, maxLen, now) {
  // slice(-0) is slice(0): with no room for the bar, take nothing, not everything.
  const items = maxLen > 0 ? s.timeline.slice(-maxLen) : [];
  return items.map((t) => {
    const live = t.ok === null && s.current && s.current.tuid === t.tuid && !s.current.done && displayStatus(s, now) !== 'ended';
    if (t.ok === false) return ['▇', st.red];
    if (live) return [phaseMark(t.phase), both(st.bold, phaseStyle(t.phase))];
    return [phaseMark(t.phase), phaseStyle(t.phase)];
  });
}

// Every state gets a duration in the same column: how long it has been like this.
// For a running tool that is the "is it stuck?" question answered without the detail
// view; for a finished turn it is what the turn cost in wall clock.
const DUR_W = 5;
const duration = (from, now, style) => [(from ? fmtDuration(Math.max(0, now - from)) : '').padEnd(DUR_W), style];

function activityLine(s, status, now) {
  const ind = '   ';
  if (status === 'approval') {
    const waited = s.statusAt ? ` for ${fmtDuration(now - s.statusAt)}` : '';
    return [[ind], [`waiting on your approval${waited}  `, both(st.bold, st.red)], [s.approval || '']];
  }
  if (status === 'ended') return [[ind], [`ended ${ago(now - (s.endedAt || s.lastAt))}`, st.gray]];
  if (status === 'yourturn' || status === 'idle') {
    const lead = status === 'idle'
      ? `idle for ${fmtDuration(now - s.lastAt)}`
      : s.lastTurnMs != null ? `turn finished in ${fmtDuration(s.lastTurnMs)}` : 'turn finished';
    return [[ind], [lead, status === 'idle' ? st.gray : st.cyan], s.lastMsg ? ['  ' + firstLine(s.lastMsg), st.dim] : null];
  }
  const quiet = status === 'quiet' ? st.yellow : st.dim;
  const c = s.current;
  if (!c) return [[ind], ['thinking'.padEnd(11), st.dim], duration(s.turnStartedAt, now, quiet)];
  const phase = PHASES[c.phase] || PHASES.other;
  // A plan update already reads as "planning" and its content is on the plan line
  // below, so naming the tool again just repeats itself.
  const target = c.phase === 'plan' ? '' : c.target || c.tool;
  if (c.done) {
    const after = target ? `after ${phase.label} ` : `after ${phase.label}`;
    return [[ind], ['thinking'.padEnd(11), st.dim], duration(c.doneAt || s.turnStartedAt, now, quiet), [after, st.dim], target ? [target, st.dim] : null];
  }
  return [[ind], [phase.label.padEnd(11), phaseStyle(c.phase)], duration(c.at, now, quiet), target ? [target] : null];
}

function statsSegs(s) {
  const out = [];
  if (s.files.size) out.push([`${s.files.size} file${s.files.size === 1 ? '' : 's'}`, st.dim]);
  out.push([`${s.tools} tool${s.tools === 1 ? '' : 's'}`, st.dim]);
  if (s.fails) out.push([`${s.fails} failed`, st.red]);
  if (s.skillCount) out.push([`${s.skillCount} skill${s.skillCount === 1 ? '' : 's'}`, phaseStyle('skill')]);
  if (s.subagents) out.push([`${s.subagents} subagent${s.subagents === 1 ? '' : 's'}`, st.cyan]);
  return out.flatMap((seg, i) => (i ? [['   '], seg] : [seg]));
}

// The files worth naming, kept inside a budget so they never crowd out the plan:
// two names when they fit, otherwise the busiest one and a count. A file already
// named on the activity line above is skipped rather than repeated.
const relPath = (s, f) => (s.cwd && f.startsWith(s.cwd + '/') ? f.slice(s.cwd.length + 1) : f);

function changedFiles(s, budget, skip) {
  const entries = [...s.files.entries()].sort((a, b) => b[1] - a[1]);
  const names = entries.map(([f]) => relPath(s, f)).filter((n) => n !== skip);
  if (!names.length) return '';
  const more = (n) => (names.length > n ? ` +${names.length - n}` : '');
  const two = `${names[0]}, ${names[1]}${more(2)}`;
  if (names.length > 1 && two.length <= budget) return two;
  return names[0] + more(1);
}

const HOOK_MARK = { ok: '✓', failed: '✗', blocked: '✗', cancelled: '✗' };
const phaseMark = (p) => (PHASES[p] || {}).mark || '▇';

// Hooks and skills are the agent's own machinery: they explain a turn that
// behaved oddly, and the line costs nothing when a session has neither.
function gearLine(s, selected, width) {
  const skills = [...s.skills.entries()].sort((a, b) => b[1] - a[1]);
  if (!s.hookCount && !skills.length) return null;
  const segs = [[selected ? '▌  ' : '   ', st.white]];
  if (s.hookCount) {
    segs.push(['hooks  ', st.bold], [`${s.hookCount} run${s.hookCount === 1 ? '' : 's'}`, s.hookFails ? st.red : st.dim]);
    for (const h of s.hooks.slice(-2)) {
      const style = h.status === 'ok' ? st.dim : st.red;
      segs.push(['   '], [h.label, st.dim], [` ${HOOK_MARK[h.status] || '?'}${h.ms != null ? ` ${h.ms}ms` : ''}`, style]);
    }
  }
  if (skills.length) {
    if (s.hookCount) segs.push(['   ']);
    const names = skills.slice(0, 3).map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ');
    segs.push(['skills  ', st.bold], [names + (skills.length > 3 ? ` +${skills.length - 3}` : ''), phaseStyle('skill')]);
  }
  return fit(segs, width);
}

function card(s, selected, width, now) {
  const status = displayStatus(s, now);
  const S = STATUS[status];
  const repo = repoInfo(s.cwd);
  const model = shortModel(s.model);
  const gutter = selected ? ['▌ ', st.white] : ['  '];
  const lines = [];

  lines.push(line(
    [gutter, [S.mark + ' ', S.style], [S.label.padEnd(11), S.style], [s.agent.padEnd(8), st.bold], [repo.name, st.bold], repo.branch ? ['  ' + repo.branch, st.dim] : null],
    [[`${model || s.sid.slice(0, 6)}  `, st.gray], [ago(now - s.lastAt), st.dim]],
    width,
  ));
  lines.push(fit([[selected ? '▌' : ' ', st.white], ...activityLine(s, status, now).filter(Boolean).map((seg, i) => (i === 0 ? [seg[0].slice(1)] : seg))], width));

  const stats = statsSegs(s);
  const statsW = stats.reduce((n, [t]) => n + textWidth(t), 0);
  const stripLen = Math.max(0, Math.min(60, width - 3 - statsW - 3));
  const bar = strip(s, stripLen, now);
  lines.push(fit([[selected ? '▌  ' : '   ', st.white], ...bar, bar.length ? ['   '] : null, ...stats], width));

  // How far through its plan, and which files it has touched: one line, two answers.
  // The plan gets the width it wants first, since it is the agent's own statement of
  // what it is doing; the file names take what is left. Below ~70 columns the stats
  // already carry the count, so the plan keeps the whole line.
  const plan = planProgress(s.plan);
  const planSegs = plan && plan.done < plan.total ? [[`plan ${plan.done}/${plan.total}  `, st.cyan], [plan.step || '']] : [];
  const planW = planSegs.reduce((n, [t]) => n + textWidth(t), 0);
  const budget = Math.min(Math.floor(width * 0.5), width - planW - 6);
  const editing = s.current && !s.current.done ? s.current.target : '';
  const files = width >= 70 && budget > 12 ? changedFiles(s, budget, editing) : '';
  if (planSegs.length || files) {
    const lead = [[selected ? '▌  ' : '   ', st.white], ...planSegs];
    const trail = files ? [['✎ ', st.yellow], [files, st.dim]] : [];
    lines.push(planSegs.length && trail.length ? line(lead, trail, width) : fit([...lead, ...trail], width));
  }
  const gear = gearLine(s, selected, width);
  if (gear) lines.push(gear);
  if (s.prompt) lines.push(fit([[selected ? '▌  ' : '   ', st.white], ['› ' + s.prompt, st.dim]], width));
  return lines;
}

function legend(width) {
  const segs = [[' ']];
  for (const p of ['explore', 'change', 'verify', 'run', 'plan', 'skill']) segs.push([phaseMark(p) + ' ', phaseStyle(p)], [PHASES[p].label + '   ', st.dim]);
  segs.push(['▇ ', st.red], ['failed', st.dim]);
  return fit(segs, width);
}

function header(store, sessions, width, now) {
  const counts = {};
  for (const s of sessions) { const k = displayStatus(s, now); counts[k] = (counts[k] || 0) + 1; }
  const right = [];
  const add = (k, text) => { if (counts[k]) right.push([`${counts[k]} ${text}   `, STATUS[k].style]); };
  add('approval', 'need you');
  add('working', 'working');
  add('quiet', 'quiet');
  add('yourturn', 'your turn');
  right.push([clock(now), st.dim]);
  return line([[' agentwatch', st.bold]], right, width);
}

export function renderList(ui, store, width, height, now) {
  const all = visibleSessions(store, now, true);
  const sessions = visibleSessions(store, now, ui.showAll);
  const hidden = all.length - sessions.length;
  const out = [header(store, sessions, width, now), legend(width), ''];

  if (!sessions.length) {
    out.push(fit([['   No agent sessions to show.', st.bold]], width));
    out.push(fit([['   Start Claude Code or Codex in any repo and it will appear here.', st.dim]], width));
    out.push(fit([['   Nothing showing up? Run ', st.dim], ['agentwatch install'], [', restart the agent, and in Codex trust the hooks under /hooks.', st.dim]], width));
  }

  if (!sessions.some((s) => s.key === ui.selected)) ui.selected = sessions[0]?.key ?? null;
  const cards = sessions.map((s) => ({ key: s.key, lines: card(s, s.key === ui.selected, width, now) }));
  const avail = Math.max(1, height - out.length - 2);
  const sel = Math.max(0, cards.findIndex((c) => c.key === ui.selected));
  ui.top = Math.min(ui.top || 0, sel);
  const span = (from, to) => cards.slice(from, to + 1).reduce((n, c) => n + c.lines.length + 1, 0);
  while (ui.top < sel && span(ui.top, sel) > avail) ui.top++;

  let used = 0;
  if (ui.top > 0) { out.push(fit([[`   ↑ ${ui.top} more`, st.dim]], width)); used++; }
  for (let i = ui.top; i < cards.length; i++) {
    const need = cards[i].lines.length + 1;
    if (used + need > avail) { out.push(fit([[`   ↓ ${cards.length - i} more`, st.dim]], width)); used++; break; }
    out.push(...cards[i].lines, '');
    used += need;
  }
  if (out.length > height - 1) out.length = Math.max(0, height - 1);
  while (out.length < height - 1) out.push('');
  const footer = [['↑↓', st.bold], [' select   ', st.dim], ['enter', st.bold], [' details   ', st.dim], ['a', st.bold], [ui.showAll ? ' hide old   ' : ` show all${hidden ? ` (${hidden} hidden)` : ''}   `, st.dim], ['b', st.bold], [` bell ${ui.bell ? 'on' : 'off'}   `, st.dim], ['q', st.bold], [' quit', st.dim]];
  out.push(fit([[' '], ...footer], width));
  return out.slice(0, height);
}

// ── detail view ─────────────────────────────────────────────────────────────────
const KIND_STYLE = { prompt: st.white, approval: both(st.bold, st.red), fail: st.red, done: st.cyan, session: st.gray, skill: phaseStyle('skill') };

function wrap(text, width, maxLines) {
  const words = clean(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (textWidth(cur + ' ' + w) > width && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; } else cur = cur ? cur + ' ' + w : w;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  return lines;
}

export function renderDetail(ui, store, width, height, now) {
  const s = store.sessions.get(ui.selected);
  if (!s) { ui.view = 'list'; return renderList(ui, store, width, height, now); }
  const status = displayStatus(s, now);
  const S = STATUS[status];
  const repo = repoInfo(s.cwd);
  const out = [];
  out.push(line([[' agentwatch', st.bold], ['   esc back', st.dim]], [[clock(now), st.dim]], width));
  out.push('');
  out.push(fit([['   '], [S.mark + ' ' + S.label + '   ', S.style], [s.agent + '   ', st.bold], [repo.name, st.bold], repo.branch ? ['  ' + repo.branch, st.dim] : null], width));
  out.push(fit([['   '], [tildify(s.cwd) || '', st.dim], s.model ? ['   ' + s.model, st.dim] : null, [`   session ${s.sid}`, st.gray], [`   started ${ago(now - s.startedAt)}`, st.dim]], width));
  out.push(fit(activityLine(s, status, now).filter(Boolean), width));
  out.push('');
  if (s.prompt) {
    for (const [i, l] of wrap(s.prompt, width - 6, 3).entries()) out.push(fit([[i ? '     ' : '   › ', st.dim], [l]], width));
    out.push('');
  }

  // Plan and files side by side when there's room, stacked when there isn't.
  const left = [];
  const right = [];
  const plan = planProgress(s.plan);
  if (plan) {
    left.push([['Plan  ', st.bold], [`${plan.done}/${plan.total}`, st.cyan]]);
    for (const p of s.plan.slice(0, 10)) {
      const mark = p.s === 'completed' ? ['✓ ', st.green] : p.s === 'in_progress' ? ['▸ ', both(st.bold, st.cyan)] : ['· ', st.gray];
      left.push([mark, [p.t, p.s === 'completed' ? st.dim : null]]);
    }
    if (s.plan.length > 10) left.push([[`  ${s.plan.length - 10} more`, st.dim]]);
  }
  const files = [...s.files.entries()].sort((a, b) => b[1] - a[1]);
  if (files.length) {
    right.push([['Files changed  ', st.bold], [String(files.length), st.yellow]]);
    for (const [f, n] of files.slice(0, 10)) right.push([[String(n).padStart(3) + '  ', st.dim], [tildify(f.startsWith(s.cwd + '/') ? f.slice(s.cwd.length + 1) : f)]]);
    if (files.length > 10) right.push([[`     ${files.length - 10} more`, st.dim]]);
  }
  // Phase mix: where this session's effort has gone so far.
  const mix = {};
  for (const t of s.timeline) mix[t.phase] = (mix[t.phase] || 0) + 1;
  const mixSegs = Object.entries(mix).sort((a, b) => b[1] - a[1]).flatMap(([p, n]) => [['▇ ', phaseStyle(p)], [`${PHASES[p].label} ${Math.round((n / s.timeline.length) * 100)}%   `, st.dim]]);

  const colW = Math.floor((width - 6) / 2);
  if (width >= 100 && left.length && right.length) {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      out.push('   ' + fit(left[i] || [['']], colW) + '   ' + fit(right[i] || [['']], colW));
    }
    out.push('');
  } else {
    for (const block of [left, right]) {
      if (!block.length) continue;
      for (const l of block) out.push(fit([['   '], ...l], width));
      out.push('');
    }
  }
  if (mixSegs.length) { out.push(fit([['   '], ...mixSegs], width)); out.push(''); }

  // What the agent's own machinery did: hook runs come from the session
  // transcript, so they are the one thing the event log never sees.
  if (s.hooks.length) {
    out.push(fit([['   Hooks  ', st.bold], [`${s.hookCount} run${s.hookCount === 1 ? '' : 's'}`, st.dim], s.hookFails ? [`   ${s.hookFails} not ok`, st.red] : null], width));
    for (const h of s.hooks.slice(-6)) out.push(fit([['   '], [clock(h.ts) + '  ', st.dim], [hookLine(h), h.status === 'ok' ? st.dim : st.red]], width));
    if (s.hooks.length > 6) out.push(fit([[`     ${s.hooks.length - 6} earlier`, st.dim]], width));
    out.push('');
  }
  if (s.skills.size) {
    const skills = [...s.skills.entries()].sort((a, b) => b[1] - a[1]);
    out.push(fit([['   Skills  ', st.bold], [`${s.skillCount} use${s.skillCount === 1 ? '' : 's'}`, phaseStyle('skill')]], width));
    for (const [name, n] of skills.slice(0, 8)) out.push(fit([['   '], [String(n).padStart(3) + '  ', st.dim], [name]], width));
    if (skills.length > 8) out.push(fit([[`     ${skills.length - 8} more`, st.dim]], width));
    out.push('');
  }

  // Reserve one line for the Activity heading and one for the footer, so a short
  // terminal loses log lines instead of losing the keys that get you out.
  const room = Math.max(0, height - out.length - 2);
  if (room > 0) {
    out.push(fit([['   Activity', st.bold], ['   newest at the bottom', st.dim]], width));
    for (const l of s.log.slice(-room)) {
      const style = KIND_STYLE[l.kind];
      const lead = PHASES[l.kind] ? ['▇ ', phaseStyle(l.kind)] : ['  '];
      out.push(fit([['   '], [clock(l.ts) + '  ', st.dim], lead, [l.text, style]], width));
    }
  }
  if (out.length > height - 1) out.length = Math.max(0, height - 1);
  while (out.length < height - 1) out.push('');
  out.push(fit([[' '], ['esc', st.bold], [' back   ', st.dim], ['↑↓', st.bold], [' other sessions   ', st.dim], ['q', st.bold], [' quit', st.dim]], width));
  return out.slice(0, height);
}

export function render(ui, store, width, height, now = Date.now()) {
  return ui.view === 'detail' ? renderDetail(ui, store, width, height, now) : renderList(ui, store, width, height, now);
}

// ── interactive loop ────────────────────────────────────────────────────────────
export function runTui(store, { onExit } = {}) {
  const out = process.stdout;
  const ui = { view: 'list', selected: null, top: 0, showAll: false, bell: true, live: false, lastAlert: 0 };
  let lastVersion = -1;
  let lastDraw = 0;

  const draw = () => {
    const now = Date.now();
    const lines = render(ui, store, out.columns || 100, out.rows || 30, now);
    out.write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J');
    lastVersion = store.version;
    lastDraw = now;
    let maxAlert = 0;
    for (const s of store.sessions.values()) if (s.status === 'approval') maxAlert = Math.max(maxAlert, s.alertAt);
    if (ui.live && ui.bell && maxAlert > ui.lastAlert) out.write('\x07');
    ui.lastAlert = Math.max(ui.lastAlert, maxAlert);
  };

  const move = (d) => {
    const list = visibleSessions(store, Date.now(), ui.showAll);
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((s) => s.key === ui.selected));
    ui.selected = list[Math.min(list.length - 1, Math.max(0, i + d))].key;
  };

  // Hook and skill activity lives in each session's transcript, not in the log.
  const stopTranscripts = followTranscripts(store, (e) => apply(store, e));

  const cleanup = () => {
    stopTranscripts();
    out.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  const quit = () => { cleanup(); onExit?.(); process.exit(0); };

  out.write('\x1b[?1049h\x1b[?25l');
  process.on('exit', cleanup);
  process.on('SIGTERM', quit);
  process.on('uncaughtException', (err) => { cleanup(); console.error(err); process.exit(1); });
  out.on('resize', draw);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === 'q' || key === '\x03') return quit();
    if (key === '\x1b[A' || key === 'k') move(-1);
    else if (key === '\x1b[B' || key === 'j') move(1);
    else if (key === '\r' || key === '\n' || key === 'l' || key === '\x1b[C') { if (ui.selected) ui.view = 'detail'; }
    else if (key === '\x1b' || key === 'h' || key === '\x1b[D' || key === '\x7f') ui.view = 'list';
    else if (key === 'a') { ui.showAll = !ui.showAll; ui.top = 0; }
    else if (key === 'b') ui.bell = !ui.bell;
    draw();
  });

  draw();
  setTimeout(() => { ui.live = true; }, 500);
  setInterval(() => {
    if (store.version !== lastVersion || Date.now() - lastDraw >= 1000) draw();
  }, 100);
}
