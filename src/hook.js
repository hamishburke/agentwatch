// Runs once per hook event, inside Claude Code or Codex. It must be fast, quiet and
// impossible to fail loudly: no stdout (some events inject stdout into the model's
// context), and always exit 0 so the agent is never blocked by the visualiser.
import fs from 'node:fs';
import path from 'node:path';
import { AW_HOME, LOG, LOG_ROTATE_BYTES } from './paths.js';

const cut = (s, n) => {
  if (s == null) return undefined;
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, timeoutMs).unref();
  });
}

// Shell commands arrive as a string, or (older Codex) as ["bash", "-lc", "..."].
export function commandOf(ti) {
  let c = ti?.command ?? ti?.cmd;
  if (Array.isArray(c)) {
    c = c.length >= 3 && /(^|\/)(ba|z)?sh$/.test(c[0]) && /^-l?c$/.test(c[1]) ? c[2] : c.join(' ');
  }
  if (typeof c !== 'string') return undefined;
  // Unwrap `sh -c '...'` only when the quoted body is the entire command. A greedy
  // body would match across a chained command (`sh -c "a" && sh -c "b"`) and eat the
  // quotes, so the body may not contain its own delimiter.
  const wrapped = c.match(/^\s*(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])((?:(?!\1)[\s\S])*)\1\s*$/);
  return (wrapped ? wrapped[2] : c).trim();
}

export function patchFiles(text) {
  if (typeof text !== 'string') return [];
  const out = new Set();
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.add(m[1].trim());
  for (const m of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.add(m[1].trim());
  return [...out];
}

function normalisePlan(tool, ti) {
  if (tool === 'TodoWrite' && Array.isArray(ti?.todos)) {
    return ti.todos.slice(0, 30).map((t) => ({ t: cut(t.activeForm && t.status === 'in_progress' ? t.activeForm : t.content, 120), s: t.status }));
  }
  if (tool === 'update_plan' && Array.isArray(ti?.plan)) {
    return ti.plan.slice(0, 30).map((t) => ({ t: cut(t.step, 120), s: t.status }));
  }
  return undefined;
}

function firstString(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const v of Object.values(obj)) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

// Pull out the one or two things a human wants to see about a tool call.
export function summariseTool(tool, ti = {}) {
  const r = {};
  if (!tool) return r;
  if (tool === 'Bash' || tool === 'exec_command' || tool === 'shell') {
    r.cmd = cut(commandOf(ti), 400);
    r.target = r.cmd;
    return r;
  }
  if (tool === 'apply_patch') {
    r.files = patchFiles(typeof ti === 'string' ? ti : ti.command ?? ti.input ?? ti.patch).slice(0, 20);
    r.target = r.files.join(', ');
    return r;
  }
  if (tool === 'Skill' || tool === 'skill') {
    r.skill = cut(ti.skill ?? ti.name ?? ti.command, 60);
    if (r.skill) r.target = r.skill;
    return r;
  }
  const file = ti.file_path ?? ti.notebook_path ?? (['Read', 'Edit', 'Write', 'MultiEdit', 'LS'].includes(tool) ? ti.path : undefined);
  if (file) { r.files = [String(file)]; r.target = String(file); return r; }
  const plan = normalisePlan(tool, ti);
  if (plan) { r.plan = plan; return r; }
  if (tool === 'Grep') r.target = [ti.pattern, ti.path || ti.glob].filter(Boolean).join('  in ');
  else if (tool === 'Glob') r.target = ti.pattern;
  else if (tool === 'WebFetch') r.target = ti.url;
  else if (tool === 'WebSearch') r.target = ti.query;
  else if (tool === 'Task' || tool === 'Agent') r.target = ti.description || ti.prompt;
  else r.target = firstString(ti);
  r.target = cut(r.target, 200);
  return r;
}

export function failed(res) {
  if (res == null) return false;
  if (typeof res === 'string') {
    const m = res.match(/(?:exit(?:ed with)? code|process exited with code)[:\s]+(-?\d+)/i);
    return m ? m[1] !== '0' : false;
  }
  if (typeof res === 'object') {
    if (res.is_error === true || res.isError === true || res.success === false || res.interrupted === true) return true;
    for (const k of ['exit_code', 'exitCode', 'returncode', 'status_code']) {
      if (typeof res[k] === 'number') return res[k] !== 0;
    }
    if (typeof res.output === 'string') return failed(res.output);
  }
  return false;
}

export function normalise(agent, p) {
  const ev = p.hook_event_name;
  const e = {
    v: 1,
    ts: Date.now(),
    agent,
    ev,
    sid: p.session_id,
    cwd: p.cwd,
    model: p.model,
  };
  // Neither agent reports its other hooks, but both name the session transcript,
  // which records them; the view reads it from here.
  if (typeof p.transcript_path === 'string') e.tp = p.transcript_path;
  if (p.tool_name) {
    e.tool = p.tool_name;
    e.tuid = p.tool_use_id;
    Object.assign(e, summariseTool(p.tool_name, p.tool_input));
    if (ev === 'PermissionRequest' && p.tool_input?.description) e.why = cut(p.tool_input.description, 200);
  }
  if (ev === 'PostToolUse') e.ok = !failed(p.tool_response);
  if (p.prompt) e.prompt = cut(p.prompt, 300);
  if (p.message) e.msg = cut(p.message, 300);
  if (p.last_assistant_message) e.msg = cut(p.last_assistant_message, 300);
  if (p.source) e.source = p.source;
  if (p.reason) e.reason = cut(p.reason, 60);
  if (p.trigger) e.trigger = p.trigger;
  if (p.agent_type) e.agentType = cut(p.agent_type, 60);
  if (p.agent_id) e.agentId = p.agent_id;
  if (p.notification_type) e.ntype = p.notification_type;
  return e;
}

function append(e) {
  fs.mkdirSync(AW_HOME, { recursive: true });
  try {
    if (fs.statSync(LOG).size > LOG_ROTATE_BYTES) fs.renameSync(LOG, path.join(AW_HOME, 'events.1.jsonl'));
  } catch { /* missing file or another hook won the rename race */ }
  // One short line per write keeps O_APPEND writes from interleaving between agents.
  fs.appendFileSync(LOG, JSON.stringify(e) + '\n');
}

export async function runHook(agent) {
  let ev;
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      const p = JSON.parse(raw);
      ev = p?.hook_event_name;
      if (p && ev && p.session_id) append(normalise(agent, p));
    }
  } catch { /* never let the visualiser break the agent */ }
  // Codex treats empty output from these two events as invalid; everything else stays silent.
  if (agent === 'codex' && (ev === 'Stop' || ev === 'SubagentStop')) process.stdout.write('{}');
  process.exit(0);
}
