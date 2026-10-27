# agentwatch

<img width="1705" height="583" alt="image" src="https://github.com/user-attachments/assets/4770c761-1fe2-42ff-bffe-2a16dceaddfb" />

A terminal view of what your Claude Code and Codex sessions are doing, so you can see at a glance which one needs you, which ones are busy, and what each is busy with.

No dependencies. Node 18.17 or newer.

## Set up

```sh
cd agentwatch
npm link            # puts `agentwatch` on your PATH
agentwatch demo     # try it with simulated sessions first
agentwatch install  # add the hooks to Claude Code and Codex
agentwatch          # open the live view
```

After installing:

- **Claude Code** picks up the hooks in new sessions. Restart any that are already running.
- **Codex** skips new hooks until you trust them. Open `/hooks` in Codex once and trust the agentwatch entries.

`agentwatch status` shows what's installed. `agentwatch uninstall` removes only the agentwatch entries and leaves your other hooks alone. The first install keeps a `.agentwatch.bak` copy of each settings file.

The hook command points at this folder by absolute path, so if you move the folder, run `agentwatch install` again.

## Reading the view

Sessions are sorted by how much they need you:

| Status | Meaning |
|---|---|
| needs you | Blocked on an approval prompt. The terminal bell rings when this happens (`b` toggles it). |
| working | Mid-turn, calling tools or generating. |
| gone quiet | Still mid-turn, but nothing for 10 minutes. Usually a long command, sometimes a hang. |
| your turn | Finished its turn and is waiting for your next prompt. |
| idle | Your turn, untouched for 20 minutes. |
| ended | Session closed, its process has gone, or `/clear` replaced it with a new session. Hidden after 30 minutes unless you press `a`. |

Idle and ended sessions are one line each, under a divider, so the screen space goes to the sessions doing something. An idle session whose process agentwatch knows about stays listed until it is closed; one it has no process for is hidden after 3 hours.

## Subagents

Claude Code reports a subagent's tool calls under its parent's session, told apart only by an `agent_id`. Agentwatch gives each subagent its own record, so a subagent never changes the parent's status, current step or folder. Without that, a forked agent working in a worktree would make its parent look busy, and point it at the worktree, long after the parent had finished its turn.

- Each subagent is named after the `Agent` call that launched it (its `subagent_type` and description). One started by a skill shows its type only.
- A background subagent keeps running after its parent's turn ends. The card says so, and the session doesn't count as idle until the subagent finishes.
- An approval a subagent is waiting on shows on the parent as `needs you`, naming the subagent.
- A subagent with nothing for 10 minutes shows as `quiet`. After an hour agentwatch stops counting it as running.
- Claude Code also starts internal helpers that never call a tool, such as the one that suggests your next prompt. Their `SubagentStop` events are ignored.

## Closing sessions

`x` closes the selected session and `X` closes every idle one, after a `y` to confirm. Either sends the agent `SIGTERM`, the same as closing its terminal tab, and you can pick it up again with `claude --resume`. Anything typed into its prompt but not sent is lost.

`agentwatch --close-idle 90` does it for you: any session that has been waiting on you for 90 minutes is closed. It only touches sessions whose turn has finished, never one that is working, waiting on an approval or running a subagent, and it only runs while the view is open.

A session can only be closed once agentwatch knows its process, which the hook records with each prompt. Sessions that were already running when you updated agentwatch pick it up with their next prompt.

Each card is one session, and reads top to bottom:

- **Who and where** — status, agent and model, repo and branch, and how long since its last event.
- **What it is doing, and for how long** — `verifying  4m  npm test`. That duration is the age of the current step, so a number that keeps climbing is a long command, and one that stops moving while the status turns yellow is a hang. A session that has finished its turn shows how long it has been waiting on you and how long the turn took, and a blocked one shows how long you have been the blocker.
- **The strip** — one block per tool call, newest on the right, coloured by phase. Earlier turns are dimmed, so the bright run on the right is the current turn. Reading it left to right tells you the shape of the turn: a run of blue is exploration, yellow is editing, green is tests or builds, red is something that failed. A `▚` half block is a skill, which Claude Code calls like any other tool. Failures in this turn are counted beside it.
- **Subagents** — one `↳` line for each subagent still running, then the ones that finished this turn: its type, the task it was given, what it is doing now, and how long it has run. See [Subagents](#subagents).
- **Plan and files** — how far through its own plan (from `TodoWrite` in Claude Code or `update_plan` in Codex), and how many files it has changed, with their names on a wide terminal.
- **Hooks and skills** — `hooks  6 runs  sphinx.sh ✓ 14ms  format.sh ✗ 1330ms   skills  commit, review`. Present only when a session has run a hook or used a skill. Hook runs come from the session's transcript (see below), so this is the one part of a card the event log never holds.
- **Your last prompt.**

Press enter on a session for the detail view: the full plan, files changed, each subagent with what it did and its final report, how the session's effort splits across phases, every hook run with its status and duration, the skills used and how often, and a timestamped activity log.

Phases are a heuristic on tool names and shell commands, defined in `src/state.js` (`classify` and the regexes above it). A chained command is split outside quotes and stripped of setup steps (`cd`, `source`, `nvm use`, `VAR=value`, workspace flags like `pnpm --filter`), so `source ~/.nvm/nvm.sh && pnpm --filter api typecheck` reads as verifying, and a `python3 - <<EOF` script that rewrites a file reads as editing. If your projects use different test or build commands, add them to `VERIFY_CMD`.

## How it works

```
Claude Code hooks ─┐
                   ├─▶ agentwatch hook <agent> ─▶ ~/.agentwatch/events.jsonl ─▶ agentwatch (TUI)
Codex hooks ───────┘
```

Both agents run a command on lifecycle events and pass it a JSON payload on stdin. `agentwatch hook` normalises that payload into one small line and appends it to the log. It never writes to stdout (some events feed stdout back into the model's context), always exits 0, and takes about 40 ms, so it can't block or slow an agent in any way you'd notice.

The view tails the log and folds events into one record per session. Because the log is just a file, the view can be closed and reopened without losing anything, and sessions that started before you opened it still show up. The log rotates to `events.1.jsonl` at 50 MB.

Skills arrive the same way as tools: Claude Code calls one through a `Skill` tool, so it lands in the log like any other tool call, and a `/command` you type is read from the transcript.

Hooks do not. A hook is told about its own event and nothing else, so agentwatch's hook cannot see the other hooks running beside it — but every hook payload names the session transcript, and Claude Code writes each hook run into it (`hook_success`, `hook_non_blocking_error`, `hook_error_during_execution`, `hook_cancelled`, with the command, the event and the duration). So the view follows the transcript itself:

```
Claude Code transcript ─▶ agentwatch (TUI)   hook runs, /commands
```

That keeps the hook as cheap as before: it records the transcript path and nothing more. Agentwatch's own hook runs are filtered out, since you are watching your hooks, not this one. Codex writes hook runs to its rollout file too, which is a waiting follow-up.

On `SessionStart` and each prompt, the hook also walks up from its own process to the `claude` or `codex` process above it and records that PID with its start time, which adds about 15 ms to those two events and nothing to tool calls. The view checks those every 5 seconds with one `ps` call, which is how it notices a session whose terminal was closed or killed without a `SessionEnd`. The start time means a recycled PID is never mistaken for the agent, or sent a signal.

## Privacy

Everything stays on your machine in `~/.agentwatch/`. The log holds prompts, shell commands and file paths, each cut to a few hundred characters. It doesn't store file contents or tool output. Delete the folder whenever you like.

The transcript the view reads is the agent's own, not a copy: it is read from the last megabyte, never written to, and only hook and `/command` lines are kept.

## Options

- `--file <path>` reads a different log.
- `--close-idle <minutes>` closes sessions that have waited on you that long (see [Closing sessions](#closing-sessions)).
- `agentwatch snapshot --width 120 --height 40` prints one frame and exits, which is handy for checking layout or piping into something else.
- `AGENTWATCH_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` override the default locations.

## Keys

`↑ ↓` or `j k` select, `enter` details, `esc` back, `x` close the selected session, `X` close all idle sessions, `a` show or hide old sessions, `b` bell, `q` quit.
