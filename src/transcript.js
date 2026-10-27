// Claude Code never tells a hook about its neighbours, but it does write every
// hook run into the session transcript: an `attachment` line whose type is
// hook_success, hook_non_blocking_error, hook_error_during_execution or
// hook_cancelled, carrying the command, its event and how long it took. The same
// transcript marks a user-typed /command as a <command-name> block.
//
// Each hook payload carries that transcript's path, so the agent's hook stays as
// cheap as before and the view reads the transcript itself. Only hook and skill
// activity is taken from it; everything else still comes from the event log.
import { follow } from './tail.js';

// Enough of a session's past to fill the card when the view opens mid-turn.
const BACKLOG_BYTES = 1024 * 1024;

// Our own hook runs are not what the developer is watching.
const OUR_HOOK = /agentwatch\S*\s+hook\s+(claude|codex)\b/;
const RUNNER = /^(sh|bash|zsh|dash|node|bun|deno|python3?|env|time|npx|exec)$/;

const HOOK_STATUS = {
  hook_success: 'ok',
  hook_non_blocking_error: 'failed',
  hook_error_during_execution: 'failed',
  hook_blocking_error: 'blocked',
  hook_cancelled: 'cancelled',
};

const cut = (s, n) => {
  if (s == null) return undefined;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// A hook's identity is its command. A script gets to be called by its own name;
// anything else (`echo 'x'`, a pipeline) reads better in full.
export function hookLabel(command, fallback) {
  const first = String(command || '').trim().split(/\s+/)[0];
  if (!first) return fallback;
  if (!first.includes('/')) return cut(String(command), 40);
  return first.split('/').pop() || fallback;
}

export function hookRunFrom(line) {
  if (!line || line.type !== 'attachment') return null;
  const a = line.attachment;
  const status = a && HOOK_STATUS[a.type];
  if (!status) return null;
  if (OUR_HOOK.test(a.command || '')) return null;
  const event = a.hookEvent || a.hookName || 'hook';
  return {
    ev: 'HookRun',
    ts: Date.parse(line.timestamp) || Date.now(),
    hook: {
      id: line.uuid,
      event,
      label: hookLabel(a.command, event),
      status,
      ms: typeof a.durationMs === 'number' ? a.durationMs : undefined,
      timedOut: a.timedOut === true,
      out: cut(a.content || a.stdout || a.stderr, 200),
    },
  };
}

// `/name args` is wrapped in <command-name> markers in the user's own entry.
export function skillUseFrom(line) {
  if (!line || line.type !== 'user' || !line.message) return null;
  let text;
  try { text = JSON.stringify(line.message.content ?? ''); } catch { return null; }
  const m = text.match(/<command-name>\s*\/?([^<\\"]+?)\s*<\\?\/command-name>/);
  if (!m) return null;
  return { ev: 'SkillUse', ts: Date.parse(line.timestamp) || Date.now(), skill: cut(m[1], 60), id: line.uuid };
}

const toEvent = (line) => hookRunFrom(line) || skillUseFrom(line);

function hand(s, apply) {
  return (line) => {
    const e = toEvent(line);
    if (!e) return;
    e.agent = s.agent;
    e.sid = s.sid;
    apply(e);
  };
}

export function followTranscript(s, apply) {
  return follow(s.tp, hand(s, apply), { backlogBytes: BACKLOG_BYTES, intervalMs: 400 });
}

// One pass, for `agentwatch snapshot`.
export function snapshotTranscripts(store, apply) {
  for (const s of store.sessions.values()) {
    if (!s.tp) continue;
    const stop = followTranscript(s, apply);
    stop();
  }
}

// Every session that names a transcript gets one follower, created the moment the
// session appears. Followers outlive the session's events on purpose: the last
// hook of a turn is written after the turn's final hook event.
export function followTranscripts(store, apply) {
  const running = new Map();
  const sync = () => {
    for (const s of store.sessions.values()) {
      if (!s.tp || running.has(s.key)) continue;
      running.set(s.key, followTranscript(s, apply));
    }
  };
  sync();
  const timer = setInterval(sync, 500);
  return () => {
    clearInterval(timer);
    for (const stop of running.values()) stop();
  };
}
