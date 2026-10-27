import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Writes scripted sessions into a throwaway log so the UI can be tried without
// running a real agent. Each script loops so the demo keeps moving.
export function startDemo() {
  const root = path.join(os.tmpdir(), 'agentwatch-demo');
  const file = path.join(root, 'events.jsonl');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, '');
  const repo = (name, branch) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    return dir;
  };

  let n = 0;
  const write = (e) => fs.appendFileSync(file, JSON.stringify({ v: 1, ts: Date.now(), ...e }) + '\n');
  const tool = (tool, extra = {}, ok = true, ms = 900) => ({ tool, extra, ok, ms });

  const plan = (done, steps) => steps.map((t, i) => ({ t, s: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }));
  // Hook runs only exist for Claude in the demo: Codex records them for real, but
  // the view doesn't read them yet, and the demo shouldn't show what it can't.
  const hooks = (event, command, status = 'ok', ms = 12) => ({ event, label: command.split('/').pop(), status, ms });
  const navSteps = ['Find where the nav and hero overlap', 'Fix the header height at small breakpoints', 'Run the visual tests', 'Tidy up the old media query'];

  const scripts = [
    {
      agent: 'claude', sid: 'c7f3a1e2-demo-web', cwd: repo('web-app', 'fix/mobile-nav'), model: 'claude-opus',
      prompt: 'The nav overlaps the hero on mobile. Fix it and make sure the visual tests still pass.',
      steps: [
        tool('TodoWrite', { plan: plan(0, navSteps) }, true, 600),
        tool('Skill', { skill: 'commit', target: 'commit' }, true, 900),
        {
          background: {
            type: 'Explore', desc: 'Find every place the header height is set',
            steps: [
              tool('Grep', { target: 'header-height  in src' }, true, 1500),
              tool('Read', { files: ['src/styles/tokens.css'], target: 'src/styles/tokens.css' }, true, 1800),
              tool('Bash', { cmd: 'rg -n "--header-h" src', target: 'rg -n "--header-h" src' }, true, 2500),
              tool('Read', { files: ['src/components/MobileMenu.tsx'], target: 'src/components/MobileMenu.tsx' }, true, 2200),
            ],
            final: 'The height is set in tokens.css and overridden in MobileMenu.tsx.',
          },
        },
        tool('Grep', { target: 'position: fixed  in src' }),
        tool('Read', { files: ['src/components/Header.tsx'], target: 'src/components/Header.tsx' }),
        tool('Read', { files: ['src/components/Hero.tsx'], target: 'src/components/Hero.tsx' }),
        tool('Glob', { target: 'src/styles/**/*.css' }),
        tool('Read', { files: ['src/styles/layout.css'], target: 'src/styles/layout.css' }),
        tool('TodoWrite', { plan: plan(1, navSteps) }, true, 500),
        tool('Edit', { files: ['src/components/Header.tsx'], target: 'src/components/Header.tsx' }, true, 1400),
        tool('Edit', { files: ['src/styles/layout.css'], target: 'src/styles/layout.css' }, true, 1200),
        tool('TodoWrite', { plan: plan(2, navSteps) }, true, 500),
        tool('Bash', { cmd: 'npm run test:visual -- header', target: 'npm run test:visual -- header' }, false, 4000),
        tool('Read', { files: ['tests/visual/header.spec.ts'], target: 'tests/visual/header.spec.ts' }),
        tool('Edit', { files: ['src/styles/layout.css'], target: 'src/styles/layout.css' }, true, 1200),
        tool('Bash', { cmd: 'npm test', target: 'npm test' }, true, 5000),
        tool('TodoWrite', { plan: plan(3, navSteps) }, true, 500),
        tool('Edit', { files: ['src/styles/legacy.css'], target: 'src/styles/legacy.css' }, true, 1000),
        tool('Bash', { cmd: 'git diff --stat', target: 'git diff --stat' }),
        tool('TodoWrite', { plan: plan(4, navSteps) }, true, 500),
      ],
      final: 'Fixed: the header now uses a fixed height below 640px and the hero offsets by it. Visual tests pass.',
      hooks: [hooks('UserPromptSubmit', '~/.claude/hooks/sphinx.sh', 'ok', 14), hooks('PreToolUse', '~/.claude/hooks/guard.sh', 'ok', 4), hooks('Stop', '~/.claude/hooks/format.sh', 'failed', 8)],
      rest: 9000,
    },
    {
      agent: 'codex', sid: '019a2b4c-demo-api', cwd: repo('api', 'feat/rate-limits'), model: 'gpt-codex',
      prompt: 'Add rate limiting to the public endpoints, 100 requests a minute per key.',
      steps: [
        tool('update_plan', { plan: plan(0, ['Survey the public routes', 'Add the limiter middleware', 'Cover it with tests']) }, true, 500),
        tool('Bash', { cmd: 'rg -n "router\\.(get|post)" src/routes', target: 'rg -n "router\\.(get|post)" src/routes' }),
        tool('Bash', { cmd: "sed -n '1,120p' src/app.ts", target: "sed -n '1,120p' src/app.ts" }),
        tool('Bash', { cmd: 'ls src/middleware', target: 'ls src/middleware' }),
        { approval: 'npm install express-rate-limit', ms: 9000 },
        tool('Bash', { cmd: 'npm install express-rate-limit', target: 'npm install express-rate-limit' }, true, 3000),
        tool('update_plan', { plan: plan(1, ['Survey the public routes', 'Add the limiter middleware', 'Cover it with tests']) }, true, 500),
        tool('apply_patch', { files: ['src/middleware/rateLimit.ts', 'src/app.ts'], target: 'src/middleware/rateLimit.ts, src/app.ts' }, true, 1800),
        { subagent: 'test-writer', ms: 6000 },
        tool('apply_patch', { files: ['tests/rateLimit.test.ts'], target: 'tests/rateLimit.test.ts' }, true, 1500),
        tool('Bash', { cmd: 'npx vitest run tests/rateLimit.test.ts', target: 'npx vitest run tests/rateLimit.test.ts' }, true, 4500),
        tool('update_plan', { plan: plan(3, ['Survey the public routes', 'Add the limiter middleware', 'Cover it with tests']) }, true, 500),
      ],
      final: 'Added a per-key limiter (100/min) on /v1 public routes, with tests for the 429 path.',
      rest: 12000,
    },
    {
      agent: 'claude', sid: 'a94d0b7e-demo-docs', cwd: repo('docs-site', 'main'), model: 'claude-sonnet',
      prompt: 'Update the install guide for Node 22.',
      steps: [
        tool('Read', { files: ['docs/install.md'], target: 'docs/install.md' }),
        tool('Edit', { files: ['docs/install.md'], target: 'docs/install.md' }, true, 800),
        tool('Bash', { cmd: 'npm run build', target: 'npm run build' }, true, 2500),
      ],
      final: 'Install guide now targets Node 22 and the site builds cleanly.',
      rest: 60000,
    },
  ];

  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  function play(sc) {
    const base = { agent: sc.agent, sid: sc.sid, cwd: sc.cwd, model: sc.model };
    write({ ...base, ev: 'UserPromptSubmit', prompt: sc.prompt });
    for (const h of sc.hooks || []) {
      write({ ...base, ev: 'HookRun', hook: { id: `demo_hook_${++n}`, event: h.event, label: h.label, status: h.status, ms: h.ms } });
    }
    let i = 0;
    const next = () => {
      if (i >= sc.steps.length) {
        write({ ...base, ev: 'Stop', msg: sc.final });
        return later(sc.rest, () => play(sc));
      }
      const step = sc.steps[i++];
      if (step.approval) {
        write({ ...base, ev: 'PermissionRequest', tool: 'Bash', target: step.approval });
        return later(step.ms, next);
      }
      if (step.background) {
        const b = step.background;
        const tuid = `demo_${++n}`;
        const agentId = `demo_agent_${n}`;
        write({ ...base, ev: 'PreToolUse', tool: 'Agent', tuid, target: b.desc, subagentType: b.type, background: true });
        later(300, () => write({ ...base, ev: 'PostToolUse', tool: 'Agent', tuid, ok: true }));
        let j = 0;
        const sub = () => {
          if (j >= b.steps.length) return write({ ...base, ev: 'SubagentStop', agentId, agentType: b.type, msg: b.final });
          const t = b.steps[j++];
          const id = `demo_${++n}`;
          write({ ...base, ev: 'PreToolUse', tool: t.tool, tuid: id, agentId, agentType: b.type, ...t.extra });
          later(t.ms, () => { write({ ...base, ev: 'PostToolUse', tool: t.tool, tuid: id, agentId, agentType: b.type, ok: t.ok, ...t.extra }); later(400, sub); });
        };
        later(600, sub);
        return later(500, next);
      }
      if (step.subagent) {
        write({ ...base, ev: 'SubagentStart', agentType: step.subagent });
        return later(step.ms, () => { write({ ...base, ev: 'SubagentStop', agentType: step.subagent }); next(); });
      }
      const tuid = `demo_${++n}`;
      write({ ...base, ev: 'PreToolUse', tool: step.tool, tuid, ...step.extra });
      later(step.ms, () => {
        write({ ...base, ev: 'PostToolUse', tool: step.tool, tuid, ok: step.ok, ...step.extra });
        later(350, next);
      });
    };
    later(700, next);
  }

  for (const sc of scripts) write({ agent: sc.agent, sid: sc.sid, cwd: sc.cwd, model: sc.model, ev: 'SessionStart', source: 'startup' });
  scripts.forEach((sc, i) => later(400 + i * 1500, () => play(sc)));
  return { file, stop: () => timers.forEach(clearTimeout) };
}
