// Folds the event stream into one record per agent session, and classifies each
// tool call into a phase so a session can be read at a glance.

export const PHASES = {
  explore: { label: 'exploring', color: 'blue' },
  change: { label: 'editing', color: 'yellow' },
  verify: { label: 'verifying', color: 'green' },
  run: { label: 'running', color: 'magenta' },
  plan: { label: 'planning', color: 'cyan' },
  delegate: { label: 'delegating', color: 'cyan' },
  // A skill keeps the cyan of the agent's own decisions but gets its own mark, so
  // the strip distinguishes "ran a procedure" from planning or delegating.
  skill: { label: 'using skill', color: 'cyan', bold: true, mark: '▚' },
  other: { label: 'working', color: 'gray' },
};

const EXPLORE_TOOLS = /^(Read|Glob|Grep|LS|WebFetch|WebSearch|NotebookRead|view_image|read_file|list_dir|grep_files|BashOutput)$/;
const CHANGE_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/;
const PLAN_TOOLS = /^(TodoWrite|update_plan|ExitPlanMode|EnterPlanMode)$/;
const DELEGATE_TOOLS = /^(Task|Agent|spawn_agent)$/;
const SKILL_TOOLS = /^(Skill|skill|use_skill|skills?\.[A-Za-z_]+)$/;
const SHELL_TOOLS = /^(Bash|exec_command|shell)$/;

const VERIFY_CMD = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|check|typecheck|type-check|e2e|ci)(\b|:)/,
  /^(npx|pnpm\s+exec|pnpm\s+dlx|bunx|yarn\s+dlx)?\s*(jest|vitest|mocha|ava|playwright|cypress|tsc|eslint|prettier|biome|stylelint|ruff|mypy|pyright|pytest|next\s+(build|lint)|vite\s+build|astro\s+(check|build))\b/,
  /^(cargo|go)\s+(test|check|clippy|build|vet)\b/,
  /^(make|just)\b/,
  /^python\S*\s+-m\s+(pytest|unittest|mypy)\b/,
  /^(dotnet|mvn|gradle|\.\/gradlew)\s+(test|build|verify|check)\b/,
];
// Every alternative is anchored on a word boundary: without one, `mv` matches `mvn`
// and `ln` matches `lnav`, so a Maven build is painted as an edit.
const CHANGE_CMD = /^(?:(?:mv|cp|rm|rmdir|mkdir|touch|ln|chmod)\b|git\s+(?:add|commit|mv|rm|restore|apply|stash|switch|checkout|merge|rebase|push)\b|gh\s+pr\s+create\b|sed\s+-i\b|(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall)\b)/;
const EXPLORE_CMD = /^(rg|grep|ag|ls|cat|bat|head|tail|less|sed\s+-n|awk|find|fd|tree|wc|pwd|nl|file|stat|du|df|jq|yq|which|whence|type|command\s+-v|echo|printf|date|diff|sort|uniq|cut|tr|basename|dirname|realpath|readlink|ps|lsof|env|printenv|git\s+(status|diff|log|show|blame|branch|grep|ls-files|rev-parse|rev-list|symbolic-ref|for-each-ref|remote|tag\s+(-l|--list)|worktree\s+list|config\s+--get)|aws\s+\S+\s+(list|describe|get)[\w-]*|curl\b(?!.*\s(-X|--request|-d|--data|-F|--form)\b)|gh\s+(pr|run|issue)\s+(view|list|checks|diff|status)|claude\s+(plugin|mcp)\s+list)\b/;
const SETUP_CMD = /^(cd|pushd|popd|source|\.|export|unset|set|nvm\s+use|true|:|done|fi|esac|else|for\s.*\sin\b|while\b|if\b|\[\[?\s)(\s|$)|^\w+=\S*$|^\w+=\$\(/;
const SCRIPT_WRITE = /^(python\S*|node|ruby|perl)\s.*(\.write(_text)?\(|writeFileSync|open\([^)]*['"][wa]['"]|\.read\(\)(\.replace\(|;))/;
const REDIRECT_WRITE = /(^|[^0-9&])>>?\s*(?!\/dev\/null|&)\S/;

function segmentsOf(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '<' && cmd[i + 1] === '<') { cur += cmd.slice(i); break; }
    if (c === ';' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      if (cmd[i + 1] === c) i++;
      out.push(cur); cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function normaliseSegment(s) {
  s = s.trim().replace(/^(?:(?:do|then|else)\s+|[({]\s*)/, '');
  for (let prev; prev !== s;) {
    prev = s;
    s = s.replace(/^(sudo|env|time|command|nice|exec)\s+/, '').replace(/^\w+=('[^']*'|"[^"]*"|\S*)\s+(?=\S)/, '');
  }
  s = s.replace(/^\S*\/(\S+)/, '$1').replace(/^node\s+\S*\/(npm|pnpm|yarn|npx)\b/, '$1');
  return s.replace(/^(npm|pnpm|yarn|bun)((?:\s+(?:--filter|-F|-C|--dir|--prefix|--workspace|-w)(?:=\S+|\s+\S+)|\s+-r|\s+--recursive)+)/, '$1');
}

export function classifyCommand(cmd = '') {
  const segments = segmentsOf(cmd).map(normaliseSegment).filter((s) => s && !SETUP_CMD.test(s));
  if (segments.some((s) => VERIFY_CMD.some((re) => re.test(s)))) return 'verify';
  if (segments.some((s) => CHANGE_CMD.test(s) || SCRIPT_WRITE.test(s) || REDIRECT_WRITE.test(s.replace(/'[^']*'|"[^"]*"/g, '')))) return 'change';
  if (segments.length && segments.every((s) => EXPLORE_CMD.test(s))) return 'explore';
  return 'run';
}

export function classify(tool, cmd) {
  if (!tool) return 'other';
  if (SHELL_TOOLS.test(tool)) return classifyCommand(cmd);
  if (CHANGE_TOOLS.test(tool)) return 'change';
  if (EXPLORE_TOOLS.test(tool)) return 'explore';
  if (PLAN_TOOLS.test(tool)) return 'plan';
  if (SKILL_TOOLS.test(tool)) return 'skill';
  if (DELEGATE_TOOLS.test(tool)) return 'delegate';
  if (/^mcp__/.test(tool)) return /(read|get|list|search|find|fetch|query)/i.test(tool) ? 'explore' : 'run';
  return 'other';
}

const TIMELINE_MAX = 300;
const LOG_MAX = 300;
const HOOKS_MAX = 60;

function newSession(e) {
  return {
    key: `${e.agent}:${e.sid}`,
    agent: e.agent,
    sid: e.sid,
    cwd: e.cwd,
    model: e.model,
    startedAt: e.ts,
    lastAt: e.ts,
    status: 'yourturn',
    statusAt: e.ts,
    approval: null,
    prompt: null,
    turnStartedAt: null,
    lastTurnMs: null,
    current: null,
    lastMsg: null,
    timeline: [],
    files: new Map(),
    tools: 0,
    fails: 0,
    plan: null,
    agents: new Map(),
    launches: [],
    agentSeq: 0,
    tp: null,
    hooks: [],
    hookSeen: new Set(),
    hookCount: 0,
    hookFails: 0,
    skills: new Map(),
    skillCount: 0,
    log: [],
    endedAt: null,
    endReason: null,
    alertAt: 0,
    turn: 0,
    pid: null,
    pstart: null,
  };
}

function setStatus(s, status, ts) {
  if (s.status !== status) { s.status = status; s.statusAt = ts; }
}

export function markEnded(s, ts, reason, text) {
  setStatus(s, 'ended', ts);
  s.endedAt = ts;
  s.endReason = reason;
  s.approval = null;
  if (s.current) s.current.done = true;
  for (const a of s.agents.values()) endSubagent(s, a, ts);
  note(s, ts, 'session', text);
}

// ── subagents ──────────────────────────────────────────────────────────────────
// Subagent tool calls arrive under the parent's session id, told apart only by agent_id.
const AGENTS_MAX = 30;
const SUB_QUIET = 10 * 60_000;
const SUB_LOST = 60 * 60_000;

export const subLabel = (a) => [a.type, a.desc].filter(Boolean).join(' — ') || 'subagent';

function newSubagent(s, id, e) {
  const type = e.agentType || null;
  const i = Math.max(s.launches.findIndex((l) => type && l.type === type), s.launches.length ? 0 : -1);
  const launch = i >= 0 ? s.launches.splice(i, 1)[0] : null;
  const a = {
    id, type: type || launch?.type || null, desc: launch?.desc || null, launchTuid: launch?.tuid || null,
    background: !!launch?.background, startedAt: launch?.at ?? e.ts, lastAt: e.ts, endedAt: null,
    turn: s.turn, cwd: e.cwd || s.cwd, current: null, tools: 0, fails: 0, files: new Map(), phases: {}, lastMsg: null,
  };
  s.agents.set(id, a);
  if (s.agents.size > AGENTS_MAX) {
    const oldest = [...s.agents.values()].find((x) => x.endedAt);
    if (oldest) s.agents.delete(oldest.id);
  }
  note(s, e.ts, 'delegate', `subagent started: ${subLabel(a)}${a.background ? ' (background)' : ''}`);
  return a;
}

function endSubagent(s, a, ts, msg) {
  if (a.endedAt) return;
  a.endedAt = ts;
  if (msg) a.lastMsg = msg;
  if (a.current) a.current.done = true;
  note(s, ts, 'delegate', `subagent finished: ${subLabel(a)} in ${fmtDuration(ts - a.startedAt)}`);
}

function applySubagentTool(s, e) {
  const a = s.agents.get(e.agentId) || newSubagent(s, e.agentId, e);
  a.lastAt = Math.max(a.lastAt, e.ts);
  if (e.agentType && !a.type) a.type = e.agentType;
  if (e.cwd) a.cwd = e.cwd;
  if (e.ev === 'PreToolUse') {
    const phase = classify(e.tool, e.cmd);
    a.current = { tool: e.tool, tuid: e.tuid, phase, target: e.target, at: e.ts, done: false };
    a.tools++;
    a.phases[phase] = (a.phases[phase] || 0) + 1;
    if (phase === 'change') for (const f of e.files || []) a.files.set(f, (a.files.get(f) || 0) + 1);
    if (e.skill) bumpSkill(s, e.skill);
    return;
  }
  const ok = e.ok !== false;
  if (a.current && a.current.tuid === e.tuid) { a.current.done = true; a.current.doneAt = e.ts; }
  if (!ok) { a.fails++; note(s, e.ts, 'fail', `${a.type || 'subagent'} failed: ${describe(e, classify(e.tool, e.cmd))}`); }
  // The subagent ran the tool, so whatever approval was pending has been answered.
  if (s.status === 'approval') { setStatus(s, s.turnStartedAt ? 'working' : 'yourturn', e.ts); s.approval = null; }
}

export function runningSubagents(s, now) {
  return [...s.agents.values()].filter((a) => !a.endedAt && now - a.lastAt < SUB_LOST);
}

export function subagentState(a, now) {
  if (a.endedAt) return 'done';
  if (now - a.lastAt >= SUB_LOST) return 'lost';
  return now - a.lastAt >= SUB_QUIET ? 'quiet' : 'running';
}

// /clear starts a new session in the same process without always ending the old one.
function claimProcess(store, s, e) {
  for (const other of store.sessions.values()) {
    if (other !== s && other.pid === e.pid && other.pstart === e.pstart && other.status !== 'ended') {
      markEnded(other, e.ts, 'replaced', 'replaced by a new session in the same terminal');
    }
  }
  s.pid = e.pid;
  s.pstart = e.pstart;
}

// Transcript-derived notes (hook runs, /commands) arrive after the events that
// surround them, so the log is kept in time order rather than arrival order.
function note(s, ts, kind, text) {
  let i = s.log.length;
  while (i > 0 && s.log[i - 1].ts > ts) i--;
  s.log.splice(i, 0, { ts, kind, text });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
}

function pendingTool(s) {
  const open = [s.current && { c: s.current, who: null }, ...[...s.agents.values()].filter((a) => !a.endedAt).map((a) => a.current && { c: a.current, who: a.type || 'subagent' })]
    .filter((x) => x && !x.c.done)
    .sort((x, y) => y.c.at - x.c.at);
  if (!open.length) return null;
  const { c, who } = open[0];
  return `${who ? `${who}: ` : ''}${c.target || c.tool}`;
}

function describe(e, phase) {
  const what = e.target || e.tool;
  if (phase === 'plan' && e.plan) return `updated plan (${e.plan.filter((p) => p.s === 'completed').length}/${e.plan.length} done)`;
  if (phase === 'skill') return `skill: ${e.skill || what || 'unknown'}`;
  return `${e.tool}  ${what && what !== e.tool ? what : ''}`.trim();
}

// Skills are worth counting, not just listing: which one, and how often.
function bumpSkill(s, name) {
  s.skills.set(name, (s.skills.get(name) || 0) + 1);
  s.skillCount++;
}

const HOOK_VERB = { ok: 'ran', failed: 'failed', blocked: 'blocked', cancelled: 'cancelled' };

export function hookLine(h) {
  const took = h.timedOut ? ` timed out${h.ms != null ? ` after ${h.ms}ms` : ''}` : h.ms != null ? ` ${h.ms}ms` : '';
  return `${h.event} hook ${h.label} ${HOOK_VERB[h.status] || h.status}${took}`;
}

export function createStore() {
  return { sessions: new Map(), version: 0 };
}

export function apply(store, e) {
  if (!e || !e.sid || !e.agent || !e.ev) return;
  const key = `${e.agent}:${e.sid}`;
  let s = store.sessions.get(key);
  if (!s) { s = newSession(e); store.sessions.set(key, s); }
  s.lastAt = Math.max(s.lastAt, e.ts);
  if (e.cwd && !e.agentId) s.cwd = e.cwd;
  if (e.model) s.model = e.model;
  if (e.tp) s.tp = e.tp;
  if (s.status === 'ended' && e.ev !== 'SessionEnd') s.endedAt = null;
  if (e.pid && (e.pid !== s.pid || e.pstart !== s.pstart)) claimProcess(store, s, e);
  if (e.agentId && (e.ev === 'PreToolUse' || e.ev === 'PostToolUse')) {
    applySubagentTool(s, e);
    store.version++;
    return;
  }

  switch (e.ev) {
    case 'SessionStart':
      if (s.status === 'ended') setStatus(s, 'yourturn', e.ts);
      note(s, e.ts, 'session', { resume: 'session resumed', clear: 'context cleared', compact: 'context compacted', fork: 'session forked' }[e.source] || 'session started');
      break;

    case 'UserPromptSubmit':
      setStatus(s, 'working', e.ts);
      s.approval = null;
      s.prompt = e.prompt || s.prompt;
      s.turnStartedAt = e.ts;
      s.turn++;
      s.lastMsg = null;
      note(s, e.ts, 'prompt', `you: ${e.prompt || '(prompt)'}`);
      break;

    case 'PreToolUse': {
      const phase = classify(e.tool, e.cmd);
      if (s.status !== 'approval') setStatus(s, 'working', e.ts);
      s.current = { tool: e.tool, tuid: e.tuid, phase, target: e.target, at: e.ts, done: false };
      const existing = e.tuid && s.timeline.find((t) => t.tuid === e.tuid);
      if (!existing) {
        s.timeline.push({ tuid: e.tuid, phase, ok: null, ts: e.ts, turn: s.turn });
        if (s.timeline.length > TIMELINE_MAX) s.timeline.splice(0, s.timeline.length - TIMELINE_MAX);
        s.tools++;
      }
      if (phase === 'change') for (const f of e.files || []) s.files.set(f, (s.files.get(f) || 0) + 1);
      if (e.plan) s.plan = e.plan;
      if (e.skill) bumpSkill(s, e.skill);
      if (phase === 'delegate' && !existing) {
        s.launches = s.launches.filter((l) => e.ts - l.at < 10 * MIN);
        s.launches.push({ tuid: e.tuid, desc: e.target, type: e.subagentType, background: !!e.background, at: e.ts });
        if (s.launches.length > 10) s.launches.shift();
      }
      note(s, e.ts, phase, describe(e, phase));
      break;
    }

    case 'PermissionRequest':
      setStatus(s, 'approval', e.ts);
      s.approval = e.why || e.target || e.tool || 'a tool call';
      s.alertAt = e.ts;
      note(s, e.ts, 'approval', `needs approval: ${s.approval}`);
      break;

    case 'Notification': {
      const msg = e.msg || '';
      if (e.ntype === 'permission_prompt' || /permission|approv/i.test(msg)) {
        setStatus(s, 'approval', e.ts);
        s.approval = pendingTool(s) || msg;
        s.alertAt = e.ts;
        note(s, e.ts, 'approval', `needs approval: ${s.approval}`);
      } else {
        if (s.status !== 'working') setStatus(s, 'yourturn', e.ts);
        note(s, e.ts, 'session', msg || 'notification');
      }
      break;
    }

    case 'PostToolUse': {
      const ok = e.ok !== false;
      let entry = e.tuid && s.timeline.findLast((t) => t.tuid === e.tuid);
      if (!entry) {
        entry = { tuid: e.tuid, phase: classify(e.tool, e.cmd), ok: null, ts: e.ts, turn: s.turn };
        s.timeline.push(entry);
        s.tools++;
        if (e.plan) s.plan = e.plan;
      }
      entry.ok = ok;
      if (!ok) { s.fails++; note(s, e.ts, 'fail', `failed: ${describe(e, entry.phase)}`); }
      // A foreground Agent call returns when its subagent does; a background one returns at once.
      if (entry.phase === 'delegate') {
        const a = [...s.agents.values()].find((x) => x.launchTuid === e.tuid);
        if (a && !a.background) endSubagent(s, a, e.ts);
      }
      if (s.current && s.current.tuid === e.tuid) { s.current.done = true; s.current.ok = ok; s.current.doneAt = e.ts; }
      if (s.status === 'approval' || s.status === 'yourturn') { setStatus(s, 'working', e.ts); s.approval = null; }
      break;
    }

    // A hook run, read from the session transcript: it describes the agent's
    // environment, not the agent's progress, so it never moves the status.
    case 'HookRun': {
      const h = e.hook;
      if (!h || !h.event) break;
      if (h.id) {
        if (s.hookSeen.has(h.id)) break;
        if (s.hookSeen.size > 2000) s.hookSeen.clear();
        s.hookSeen.add(h.id);
      }
      s.hooks.push({ ts: e.ts, ...h });
      if (s.hooks.length > HOOKS_MAX) s.hooks.splice(0, s.hooks.length - HOOKS_MAX);
      s.hookCount++;
      if (h.status !== 'ok') {
        s.hookFails++;
        note(s, e.ts, 'fail', hookLine(h));
      }
      break;
    }

    // A /command the developer typed, read from the session transcript.
    case 'SkillUse': {
      if (!e.skill) break;
      if (e.id) {
        if (s.hookSeen.has(e.id)) break;
        s.hookSeen.add(e.id);
      }
      bumpSkill(s, e.skill);
      note(s, e.ts, 'skill', `you ran /${e.skill}`);
      break;
    }

    case 'SubagentStart':
      if (!s.agents.has(e.agentId)) newSubagent(s, e.agentId || `${e.agentType || 'agent'}#${++s.agentSeq}`, e);
      break;

    // Internal helpers (prompt suggestions etc.) also send SubagentStop without ever calling a tool.
    case 'SubagentStop': {
      const a = s.agents.get(e.agentId) || (!e.agentId || e.agentType ? [...s.agents.values()].find((x) => !x.endedAt && (!e.agentType || x.type === e.agentType)) : null);
      if (a) endSubagent(s, a, e.ts, e.msg);
      break;
    }

    case 'PreCompact':
      note(s, e.ts, 'session', `compacting context (${e.trigger || 'auto'})`);
      break;

    case 'Stop': {
      setStatus(s, 'yourturn', e.ts);
      s.approval = null;
      if (s.current) s.current.done = true;
      s.lastMsg = e.msg || null;
      const took = s.turnStartedAt ? e.ts - s.turnStartedAt : null;
      s.lastTurnMs = took;
      note(s, e.ts, 'done', `turn finished${took != null ? ` in ${fmtDuration(took)}` : ''}`);
      s.turnStartedAt = null;
      break;
    }

    case 'Interrupt':
      setStatus(s, 'yourturn', e.ts);
      s.approval = null;
      note(s, e.ts, 'fail', 'interrupted');
      break;

    case 'SessionEnd':
      markEnded(s, e.ts, e.reason || null, 'session ended');
      break;

    default:
      break;
  }
  store.version++;
}

const MIN = 60_000;

// How a session should read right now, including states that only exist because
// time has passed (a finished turn nobody has looked at, a tool that's gone quiet).
export function displayStatus(s, now) {
  const quiet = now - s.lastAt;
  if (s.status === 'ended') return 'ended';
  if (s.status === 'approval') return 'approval';
  if (s.status === 'working') return quiet > 10 * MIN ? 'quiet' : 'working';
  // A background subagent still working means the session isn't idle, however quiet.
  return quiet > 20 * MIN && !runningSubagents(s, now).length ? 'idle' : 'yourturn';
}

const ORDER = { approval: 0, working: 1, quiet: 2, yourturn: 3, idle: 4, ended: 5 };

export function visibleSessions(store, now, showAll) {
  return [...store.sessions.values()]
    .filter((s) => {
      if (showAll) return true;
      const st = displayStatus(s, now);
      if (st === 'ended') return now - s.lastAt < 30 * MIN;
      // Without a PID there is no way to tell an open terminal from a dead one.
      if (st === 'idle') return s.pid || now - s.lastAt < 3 * 60 * MIN;
      return true;
    })
    .sort((a, b) => ORDER[displayStatus(a, now)] - ORDER[displayStatus(b, now)] || b.lastAt - a.lastAt);
}

export function planProgress(plan) {
  if (!plan || !plan.length) return null;
  const done = plan.filter((p) => p.s === 'completed').length;
  const step = plan.find((p) => p.s === 'in_progress') || plan.find((p) => p.s !== 'completed');
  return { done, total: plan.length, step: step ? step.t : null };
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}d`;
}
