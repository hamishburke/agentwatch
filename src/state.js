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
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|check|typecheck|type-check|e2e|ci)\b/,
  /^(npx|pnpm\s+exec|pnpm\s+dlx|bunx|yarn\s+dlx)?\s*(jest|vitest|mocha|ava|playwright|cypress|tsc|eslint|prettier|biome|stylelint|ruff|mypy|pyright|pytest|next\s+(build|lint)|vite\s+build|astro\s+(check|build))\b/,
  /^(cargo|go)\s+(test|check|clippy|build|vet)\b/,
  /^(make|just)\b/,
  /^python\S*\s+-m\s+(pytest|unittest|mypy)\b/,
  /^(dotnet|mvn|gradle|\.\/gradlew)\s+(test|build|verify|check)\b/,
];
// Every alternative is anchored on a word boundary: without one, `mv` matches `mvn`
// and `ln` matches `lnav`, so a Maven build is painted as an edit.
const CHANGE_CMD = /^(?:(?:mv|cp|rm|rmdir|mkdir|touch|ln|chmod)\b|git\s+(?:add|commit|mv|rm|restore|apply|stash|switch|checkout|merge|rebase|push)\b|gh\s+pr\s+create\b|sed\s+-i\b|(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall)\b)/;
const EXPLORE_CMD = /^(rg|grep|ag|ls|cat|bat|head|tail|less|sed\s+-n|awk|find|fd|tree|wc|pwd|nl|file|stat|du|jq|which|echo|git\s+(status|diff|log|show|blame|branch|grep|ls-files))\b/;

export function classifyCommand(cmd = '') {
  const segments = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim().replace(/^(sudo|env\s+\S+=\S+)\s+/, '')).filter((s) => s && !/^cd\s/.test(s));
  if (segments.some((s) => VERIFY_CMD.some((re) => re.test(s)))) return 'verify';
  if (segments.some((s) => CHANGE_CMD.test(s))) return 'change';
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
    subagents: 0,
    tp: null,
    hooks: [],
    hookSeen: new Set(),
    hookCount: 0,
    hookFails: 0,
    skills: new Map(),
    skillCount: 0,
    log: [],
    endedAt: null,
    alertAt: 0,
  };
}

function setStatus(s, status, ts) {
  if (s.status !== status) { s.status = status; s.statusAt = ts; }
}

// Transcript-derived notes (hook runs, /commands) arrive after the events that
// surround them, so the log is kept in time order rather than arrival order.
function note(s, ts, kind, text) {
  let i = s.log.length;
  while (i > 0 && s.log[i - 1].ts > ts) i--;
  s.log.splice(i, 0, { ts, kind, text });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
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
  if (e.cwd) s.cwd = e.cwd;
  if (e.model) s.model = e.model;
  if (e.tp) s.tp = e.tp;
  if (s.status === 'ended' && e.ev !== 'SessionEnd') s.endedAt = null;

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
      s.lastMsg = null;
      note(s, e.ts, 'prompt', `you: ${e.prompt || '(prompt)'}`);
      break;

    case 'PreToolUse': {
      const phase = classify(e.tool, e.cmd);
      if (s.status !== 'approval') setStatus(s, 'working', e.ts);
      s.current = { tool: e.tool, tuid: e.tuid, phase, target: e.target, at: e.ts, done: false };
      const existing = e.tuid && s.timeline.find((t) => t.tuid === e.tuid);
      if (!existing) {
        s.timeline.push({ tuid: e.tuid, phase, ok: null, ts: e.ts });
        if (s.timeline.length > TIMELINE_MAX) s.timeline.splice(0, s.timeline.length - TIMELINE_MAX);
        s.tools++;
      }
      if (phase === 'change') for (const f of e.files || []) s.files.set(f, (s.files.get(f) || 0) + 1);
      if (e.plan) s.plan = e.plan;
      if (e.skill) bumpSkill(s, e.skill);
      if (phase === 'delegate' && s.agent === 'claude') s.subagents++; // Codex reports SubagentStart instead
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
        s.approval = s.current && !s.current.done ? s.current.target || s.current.tool : msg;
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
        entry = { tuid: e.tuid, phase: classify(e.tool, e.cmd), ok: null, ts: e.ts };
        s.timeline.push(entry);
        s.tools++;
        if (e.plan) s.plan = e.plan;
      }
      entry.ok = ok;
      if (!ok) { s.fails++; note(s, e.ts, 'fail', `failed: ${describe(e, entry.phase)}`); }
      if (entry.phase === 'delegate' && s.agent === 'claude') s.subagents = Math.max(0, s.subagents - 1);
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
      s.subagents++;
      note(s, e.ts, 'delegate', `subagent started${e.agentType ? `: ${e.agentType}` : ''}`);
      break;

    case 'SubagentStop':
      if (s.agent === 'codex') s.subagents = Math.max(0, s.subagents - 1);
      note(s, e.ts, 'delegate', `subagent finished${e.agentType ? `: ${e.agentType}` : ''}`);
      break;

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
      if (s.agent === 'claude') s.subagents = 0;
      break;
    }

    case 'Interrupt':
      setStatus(s, 'yourturn', e.ts);
      s.approval = null;
      note(s, e.ts, 'fail', 'interrupted');
      break;

    case 'SessionEnd':
      setStatus(s, 'ended', e.ts);
      s.endedAt = e.ts;
      s.approval = null;
      s.subagents = 0;
      note(s, e.ts, 'session', 'session ended');
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
  return quiet > 20 * MIN ? 'idle' : 'yourturn';
}

const ORDER = { approval: 0, working: 1, quiet: 2, yourturn: 3, idle: 4, ended: 5 };

export function visibleSessions(store, now, showAll) {
  return [...store.sessions.values()]
    .filter((s) => {
      if (showAll) return true;
      const st = displayStatus(s, now);
      if (st === 'ended') return now - s.lastAt < 30 * MIN;
      if (st === 'idle') return now - s.lastAt < 12 * 60 * MIN;
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
