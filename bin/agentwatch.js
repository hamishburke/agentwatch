#!/usr/bin/env node
// Entry point. The `hook` path is kept as light as possible because it runs on
// every tool call inside the agents, so it imports nothing it doesn't need.
const [cmd, ...rest] = process.argv.slice(2);

const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};

const HELP = `agentwatch: one terminal view of what your Claude Code and Codex sessions are doing

  agentwatch                 open the live view
  agentwatch install         add hooks to Claude Code and Codex (--claude or --codex for one)
  agentwatch uninstall       remove the hooks again
  agentwatch status          show what's installed and where events are logged
  agentwatch demo            try the view with simulated sessions
  agentwatch snapshot        print one frame and exit (--width, --height, --all)

  Options for the live view and snapshot:
    --file <path>            read events from a different log
`;

async function main() {
  if (cmd === 'hook') {
    const { runHook } = await import('../src/hook.js');
    return runHook(rest[0] === 'codex' ? 'codex' : 'claude');
  }
  if (cmd === 'install') {
    const { install } = await import('../src/install.js');
    const which = rest.includes('--claude') ? ['claude'] : rest.includes('--codex') ? ['codex'] : ['claude', 'codex'];
    return console.log(install(which));
  }
  if (cmd === 'uninstall') return console.log((await import('../src/install.js')).uninstall());
  if (cmd === 'status') return console.log((await import('../src/install.js')).status());
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);

  const { LOG } = await import('../src/paths.js');
  const { createStore, apply } = await import('../src/state.js');
  const { follow } = await import('../src/tail.js');
  const store = createStore();

  if (cmd === 'snapshot') {
    const { render } = await import('../src/tui.js');
    const { snapshotTranscripts } = await import('../src/transcript.js');
    const stop = follow(flag('file') || LOG, (e) => apply(store, e));
    stop();
    snapshotTranscripts(store, (e) => apply(store, e));
    const ui = { view: 'list', selected: null, top: 0, showAll: rest.includes('--all'), bell: false };
    const lines = render(ui, store, Number(flag('width')) || process.stdout.columns || 100, Number(flag('height')) || 40);
    return console.log(lines.join('\n'));
  }

  if (cmd && cmd !== 'demo' && !cmd.startsWith('--')) {
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    process.exit(1);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('agentwatch needs an interactive terminal. Use `agentwatch snapshot` to print a single frame.');
    process.exit(1);
  }

  let file = flag('file') || LOG;
  let demo;
  if (cmd === 'demo') {
    demo = (await import('../src/demo.js')).startDemo();
    file = demo.file;
  }
  follow(file, (e) => apply(store, e));
  const { runTui } = await import('../src/tui.js');
  runTui(store, { onExit: () => demo?.stop() });
}

main().catch((err) => {
  if (cmd === 'hook') process.exit(0);
  console.error(err.message || err);
  process.exit(1);
});
