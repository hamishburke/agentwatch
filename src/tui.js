import { PHASES, displayStatus, visibleSessions, planProgress, fmtDuration, hookLine, apply, markEnded, runningSubagents, subagentState, subLabel } from './state.js';
import { followTranscripts } from './transcript.js';
import { repoInfo } from './git.js';
import { listProcesses, isSameProcess, closeSession } from './procs.js';
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
    const old = t.turn !== undefined && t.turn !== s.turn;
    const paint = t.ok === false ? st.red : phaseStyle(t.phase);
    const mark = t.ok === false ? '▇' : phaseMark(t.phase);
    if (live) return [mark, both(st.bold, paint)];
    return [mark, old ? both(st.dim, paint) : paint];
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
    const waited = `waiting on you ${fmtDuration(now - s.statusAt)}`;
    const lead = s.lastTurnMs != null ? `${waited} · turn took ${fmtDuration(s.lastTurnMs)}` : waited;
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

function alertSegs(s) {
  const out = [];
  const turnFails = s.timeline.filter((t) => t.ok === false && t.turn === s.turn).length;
  if (turnFails) out.push([`${turnFails} failed this turn`, st.red]);
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

const SUB_LINES = 3;

function subLine(a, selected, width, now, parentBranch) {
  const state = subagentState(a, now);
  const gutter = [selected ? '▌  ' : '   ', st.white];
  const branch = repoInfo(a.cwd).branch;
  const where = branch && branch !== parentBranch ? ['  on ' + branch, st.dim] : null;
  if (state === 'done') {
    return line([gutter, ['↳ ✓ ', st.dim], [subLabel(a), st.dim]], [[`done in ${fmtDuration(a.endedAt - a.startedAt)}`, st.dim]], width);
  }
  const c = a.current;
  let doing;
  if (state === 'quiet') doing = [[`quiet ${fmtDuration(now - a.lastAt)}  `, st.yellow]];
  else if (!c) doing = [['starting  ', st.dim]];
  else if (c.done) doing = [['thinking ', st.dim], [fmtDuration(now - (c.doneAt || c.at)), st.dim]];
  else doing = [[(PHASES[c.phase] || PHASES.other).label + ' ', phaseStyle(c.phase)], [fmtDuration(now - c.at) + '  ', st.dim], [c.target || c.tool]];
  return line(
    [gutter, ['↳ ', phaseStyle('delegate')], [(a.type || 'subagent') + '  ', both(st.bold, phaseStyle('delegate'))], a.desc ? [a.desc + '   ', null] : null, ...doing, where].filter(Boolean),
    [[a.background ? 'background ' : '', st.gray], [fmtDuration(now - a.startedAt), st.dim]],
    width,
  );
}

// Running subagents first, then the ones that finished this turn, within SUB_LINES.
function subLines(s, selected, width, now) {
  const running = runningSubagents(s, now).sort((x, y) => x.startedAt - y.startedAt);
  const finished = [...s.agents.values()].filter((a) => a.endedAt && a.turn === s.turn && a.tools).sort((x, y) => y.endedAt - x.endedAt);
  const shown = [...running, ...finished];
  const room = shown.length > SUB_LINES ? SUB_LINES - 1 : SUB_LINES;
  const branch = repoInfo(s.cwd).branch;
  const lines = shown.slice(0, room).map((a) => subLine(a, selected, width, now, branch));
  const rest = shown.slice(room);
  if (rest.length) {
    const r = rest.filter((a) => !a.endedAt).length;
    const text = [r && `${r} running`, rest.length - r && `${rest.length - r} done`].filter(Boolean).join(', ');
    lines.push(fit([[selected ? '▌  ' : '   ', st.white], [`↳ +${rest.length} more subagents (${text})`, st.dim]], width));
  }
  return lines;
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
  lines.push(...subLines(s, selected, width, now));

  const alerts = alertSegs(s);
  const alertsW = alerts.reduce((n, [t]) => n + textWidth(t), 0);
  const stripLen = Math.max(0, Math.min(80, width - 3 - (alertsW ? alertsW + 3 : 0)));
  const bar = strip(s, stripLen, now);
  if (bar.length || alerts.length) lines.push(fit([[selected ? '▌  ' : '   ', st.white], ...bar, bar.length && alerts.length ? ['   '] : null, ...alerts], width));

  // How far through its plan, and which files it has touched: one line, two answers.
  // The plan gets the width it wants first, since it is the agent's own statement of
  // what it is doing; the file names take what is left. Below ~70 columns the stats
  // already carry the count, so the plan keeps the whole line.
  const plan = planProgress(s.plan);
  const planSegs = plan && plan.done < plan.total ? [[`plan ${plan.done}/${plan.total}  `, st.cyan], [plan.step || '']] : [];
  const planW = planSegs.reduce((n, [t]) => n + textWidth(t), 0);
  const count = s.files.size ? `${s.files.size} file${s.files.size === 1 ? '' : 's'}` : '';
  const budget = Math.min(Math.floor(width * 0.5), width - planW - 6) - count.length - 4;
  const editing = s.current && !s.current.done ? s.current.target : '';
  const files = width >= 70 && budget > 12 ? changedFiles(s, budget, editing) : '';
  if (planSegs.length || count) {
    const lead = [[selected ? '▌  ' : '   ', st.white], ...planSegs];
    const trail = count ? [['✎ ', st.yellow], [count, st.yellow], files ? ['  ' + files, st.dim] : null].filter(Boolean) : [];
    lines.push(planSegs.length && trail.length ? line(lead, trail, width) : fit([...lead, ...trail], width));
  }
  const gear = gearLine(s, selected, width);
  if (gear) lines.push(gear);
  if (s.prompt) lines.push(fit([[selected ? '▌  ' : '   ', st.white], ['› ' + s.prompt, st.dim]], width));
  return lines;
}

const END_REASON = { gone: 'process gone', replaced: 'replaced', clear: 'cleared', logout: 'logged out', prompt_input_exit: 'exited' };

function compactRow(s, selected, width, now) {
  const status = displayStatus(s, now);
  const S = STATUS[status];
  const repo = repoInfo(s.cwd);
  const since = status === 'ended' ? `${fmtDuration(now - s.lastAt)} ago` : fmtDuration(now - s.statusAt);
  const why = status === 'ended' ? END_REASON[s.endReason] || '' : s.pid ? '' : 'no pid yet';
  return line(
    [selected ? ['▌ ', st.white] : ['  '], [S.mark + ' ', S.style], [`${S.label} ${since}`.padEnd(17), S.style], [s.agent.padEnd(8), st.dim], [repo.name, selected ? st.bold : null], repo.branch ? ['  ' + repo.branch, st.dim] : null, s.prompt ? ['   › ' + firstLine(s.prompt), st.dim] : null],
    why ? [[why, st.gray]] : [],
    width,
  );
}

const isActive = (st) => st !== 'idle' && st !== 'ended';

function legend(width) {
  const segs = [[' ']];
  for (const p of ['explore', 'change', 'verify', 'run', 'plan', 'skill']) segs.push([phaseMark(p) + ' ', phaseStyle(p)], [PHASES[p].label + '   ', st.dim]);
  segs.push(['▇ ', st.red], ['failed', st.dim]);
  return fit(segs, width);
}

function header(ui, sessions, width, now) {
  const counts = {};
  for (const s of sessions) { const k = displayStatus(s, now); counts[k] = (counts[k] || 0) + 1; }
  const right = [];
  const add = (k, text) => { if (counts[k]) right.push([`${counts[k]} ${text}   `, STATUS[k].style]); };
  add('approval', 'need you');
  add('working', 'working');
  add('quiet', 'quiet');
  add('yourturn', 'your turn');
  add('idle', 'idle');
  if (ui.closeIdleMin) right.push([`closing idle after ${fmtDuration(ui.closeIdleMin * 60_000)}   `, st.gray]);
  right.push([clock(now), st.dim]);
  return line([[' agentwatch', st.bold]], right, width);
}

export function renderList(ui, store, width, height, now) {
  const all = visibleSessions(store, now, true);
  const sessions = visibleSessions(store, now, ui.showAll);
  const hidden = all.length - sessions.length;
  const out = [header(ui, sessions, width, now), legend(width), ''];

  if (!sessions.length) {
    out.push(fit([['   No agent sessions to show.', st.bold]], width));
    out.push(fit([['   Start Claude Code or Codex in any repo and it will appear here.', st.dim]], width));
    out.push(fit([['   Nothing showing up? Run ', st.dim], ['agentwatch install'], [', restart the agent, and in Codex trust the hooks under /hooks.', st.dim]], width));
  }

  if (!sessions.some((s) => s.key === ui.selected)) ui.selected = sessions[0]?.key ?? null;
  let divided = false;
  const cards = sessions.map((s) => {
    const selected = s.key === ui.selected;
    if (isActive(displayStatus(s, now))) return { key: s.key, lines: [...card(s, selected, width, now), ''] };
    const lines = [compactRow(s, selected, width, now)];
    if (!divided) {
      divided = true;
      const n = sessions.filter((x) => !isActive(displayStatus(x, now))).length;
      lines.unshift(fit([[`   ── idle and ended  ${n} ──`, st.dim]], width));
    }
    return { key: s.key, lines };
  });
  const avail = Math.max(1, height - out.length - 2);
  const sel = Math.max(0, cards.findIndex((c) => c.key === ui.selected));
  ui.top = Math.min(ui.top || 0, sel);
  const span = (from, to) => cards.slice(from, to + 1).reduce((n, c) => n + c.lines.length, 0);
  while (ui.top < sel && span(ui.top, sel) > avail) ui.top++;

  let used = 0;
  if (ui.top > 0) { out.push(fit([[`   ↑ ${ui.top} more`, st.dim]], width)); used++; }
  for (let i = ui.top; i < cards.length; i++) {
    const need = cards[i].lines.length;
    if (used + need > avail) { out.push(fit([[`   ↓ ${cards.length - i} more`, st.dim]], width)); used++; break; }
    out.push(...cards[i].lines);
    used += need;
  }
  if (out.length > height - 1) out.length = Math.max(0, height - 1);
  while (out.length < height - 1) out.push('');
  const key = (k, label, optional) => ({ segs: [[k, st.bold], [` ${label}   `, st.dim]], optional });
  const keys = [key('↑↓', 'select'), key('enter', 'details'), key('x', 'close'), key('X', 'close idle', true), key('a', ui.showAll ? 'hide old' : `show all${hidden ? ` (${hidden} hidden)` : ''}`), key('b', `bell ${ui.bell ? 'on' : 'off'}`, true), key('q', 'quit')];
  const segsOf = (ks) => ks.flatMap((k) => k.segs);
  const footer = textWidth(segsOf(keys).map(([t]) => t).join('')) + 1 <= width ? segsOf(keys) : segsOf(keys.filter((k) => !k.optional));
  out.push(bottomLine(ui, footer, width, now));
  return out.slice(0, height);
}

function bottomLine(ui, keys, width, now) {
  if (ui.confirm) return fit([[' '], [ui.confirm.text, both(st.bold, st.yellow)], ['   y', st.bold], [' yes   ', st.dim], ['any other key', st.bold], [' no', st.dim]], width);
  if (ui.flash && now - ui.flash.at < 5000) return fit([[' '], [ui.flash.text, ui.flash.ok ? st.green : st.red]], width);
  return fit([[' '], ...keys], width);
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
  out.push(fit([['   '], [tildify(s.cwd) || '', st.dim], s.model ? ['   ' + s.model, st.dim] : null, [`   session ${s.sid}`, st.gray], s.pid ? [`   pid ${s.pid}`, st.gray] : null, [`   started ${ago(now - s.startedAt)}`, st.dim], s.endReason ? [`   ${END_REASON[s.endReason] || s.endReason}`, st.gray] : null], width));
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

  const subs = [...s.agents.values()].filter((a) => a.tools || !a.endedAt).sort((x, y) => y.startedAt - x.startedAt);
  if (subs.length) {
    const r = runningSubagents(s, now).length;
    out.push(fit([['   Subagents  ', st.bold], [`${subs.length}`, phaseStyle('delegate')], r ? [`   ${r} running`, phaseStyle('delegate')] : null], width));
    const branch = repoInfo(s.cwd).branch;
    for (const a of subs.slice(0, 6)) {
      out.push(subLine(a, false, width, now, branch));
      const mix = Object.entries(a.phases).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([p, n]) => `${PHASES[p].label} ${n}`).join(', ');
      const facts = [`${a.tools} tool${a.tools === 1 ? '' : 's'}`, mix, a.files.size && `${a.files.size} file${a.files.size === 1 ? '' : 's'} changed`, a.fails && `${a.fails} failed`].filter(Boolean).join('   ');
      out.push(fit([['       '], [facts, a.fails ? st.red : st.dim]], width));
      if (a.lastMsg) out.push(fit([['       '], ['“' + firstLine(a.lastMsg) + '”', st.dim]], width));
    }
    if (subs.length > 6) out.push(fit([[`     ${subs.length - 6} earlier`, st.dim]], width));
    out.push('');
  }

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
  out.push(bottomLine(ui, [['esc', st.bold], [' back   ', st.dim], ['↑↓', st.bold], [' other sessions   ', st.dim], ['x', st.bold], [' close   ', st.dim], ['q', st.bold], [' quit', st.dim]], width, now));
  return out.slice(0, height);
}

export function render(ui, store, width, height, now = Date.now()) {
  return ui.view === 'detail' ? renderDetail(ui, store, width, height, now) : renderList(ui, store, width, height, now);
}

// ── interactive loop ────────────────────────────────────────────────────────────
const closable = (s, now) => s.pid && s.status !== 'ended' && ['yourturn', 'idle'].includes(displayStatus(s, now)) && !runningSubagents(s, now).length;

export function runTui(store, { onExit, closeIdleMin } = {}) {
  const out = process.stdout;
  const ui = { view: 'list', selected: null, top: 0, showAll: false, bell: true, live: false, lastAlert: 0, confirm: null, flash: null, closeIdleMin };
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

  const close = async (targets) => {
    const results = await Promise.all(targets.map(closeSession));
    const ok = results.filter((r) => r.ok).length;
    ui.flash = { at: Date.now(), ok: ok === results.length, text: results.length === 1 ? results[0].msg : `closed ${ok} of ${results.length} sessions` };
    checkProcesses();
  };

  // A killed or crashed agent never sends SessionEnd, so it would sit at "idle" for good.
  let checking = false;
  const checkProcesses = async () => {
    if (checking) return;
    checking = true;
    const live = [...store.sessions.values()].filter((s) => s.pid && s.status !== 'ended');
    const procs = await listProcesses([...new Set(live.map((s) => s.pid))]);
    checking = false;
    if (!procs) return;
    const now = Date.now();
    for (const s of live) if (!isSameProcess(s, procs.get(s.pid))) markEnded(s, now, 'gone', 'process exited without ending the session');
    if (live.length) store.version++;
    if (!ui.closeIdleMin) return;
    const stale = [...store.sessions.values()].filter((s) => closable(s, now) && now - s.statusAt > ui.closeIdleMin * 60_000);
    if (stale.length) close(stale);
  };
  checkProcesses();
  setInterval(checkProcesses, 5000);

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
  const ask = (text, run) => { ui.confirm = { text, run }; };
  process.stdin.on('data', (key) => {
    if (key === '\x03') return quit();
    if (ui.confirm) {
      const { run } = ui.confirm;
      ui.confirm = null;
      if (key === 'y' || key === 'Y') run();
      return draw();
    }
    if (key === 'q') return quit();
    if (key === '\x1b[A' || key === 'k') move(-1);
    else if (key === '\x1b[B' || key === 'j') move(1);
    else if (key === '\r' || key === '\n' || key === 'l' || key === '\x1b[C') { if (ui.selected) ui.view = 'detail'; }
    else if (key === '\x1b' || key === 'h' || key === '\x1b[D' || key === '\x7f') ui.view = 'list';
    else if (key === 'a') { ui.showAll = !ui.showAll; ui.top = 0; }
    else if (key === 'b') ui.bell = !ui.bell;
    else if (key === 'x') {
      const s = store.sessions.get(ui.selected);
      if (!s || s.status === 'ended') ui.flash = { at: Date.now(), ok: false, text: 'that session has already ended' };
      else if (!s.pid) ui.flash = { at: Date.now(), ok: false, text: 'no process recorded for this session yet; it sends one with its next prompt' };
      else {
        const subs = runningSubagents(s, Date.now()).length;
        const busy = ['working', 'quiet', 'approval'].includes(displayStatus(s, Date.now())) ? ' It is mid-turn.' : subs ? ` ${subs} subagent${subs === 1 ? ' is' : 's are'} still running.` : '';
        ask(`Close ${s.agent} in ${repoInfo(s.cwd).name} (pid ${s.pid})?${busy} Unsent prompt text is lost.`, () => close([s]));
      }
    } else if (key === 'X') {
      const idle = [...store.sessions.values()].filter((s) => closable(s, Date.now()) && displayStatus(s, Date.now()) === 'idle');
      if (!idle.length) ui.flash = { at: Date.now(), ok: false, text: 'no idle sessions with a known process to close' };
      else ask(`Close ${idle.length} idle session${idle.length === 1 ? '' : 's'} (${idle.map((s) => repoInfo(s.cwd).name).join(', ')})?`, () => close(idle));
    }
    draw();
  });

  draw();
  setTimeout(() => { ui.live = true; }, 500);
  setInterval(() => {
    if (store.version !== lastVersion || Date.now() - lastDraw >= 1000) draw();
  }, 100);
}
