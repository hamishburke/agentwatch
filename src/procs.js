import { execFile } from 'node:child_process';
import path from 'node:path';

export function listProcesses(pids) {
  return new Promise((resolve) => {
    if (!pids.length || process.platform === 'win32') return resolve(null);
    execFile('ps', ['-o', 'pid=,lstart=,comm=', '-p', pids.join(',')], { timeout: 2000 }, async (err, stdout, stderr) => {
      // macOS ps rejects the whole list over one out-of-range PID, so ask one at a time.
      if (err && stderr && pids.length > 1) {
        const each = await Promise.all(pids.map((p) => listProcesses([p])));
        return resolve(each.includes(null) ? null : new Map(each.flatMap((m) => [...m])));
      }
      // ps exits 1 when none of the PIDs exist, which is an answer, not a failure.
      if (err && !stdout && err.code !== 1) return resolve(null);
      const found = new Map();
      for (const row of String(stdout).trim().split('\n')) {
        const [pid, ...rest] = row.trim().split(/\s+/);
        if (rest.length < 6) continue;
        found.set(Number(pid), { pstart: rest.slice(0, 5).join(' '), name: path.basename(rest.slice(5).join(' ')).replace(/^-/, '') });
      }
      resolve(found);
    });
  });
}

export const isSameProcess = (s, p) => !!p && p.pstart === s.pstart && (p.name === s.agent || p.name.startsWith(`${s.agent}-`));

export async function closeSession(s) {
  if (!s.pid) return { ok: false, msg: `no process recorded for this session yet (it sends one with its next prompt)` };
  const procs = await listProcesses([s.pid]);
  if (!procs) return { ok: false, msg: `couldn't check process ${s.pid}` };
  if (!isSameProcess(s, procs.get(s.pid))) return { ok: false, msg: `process ${s.pid} has already exited` };
  try {
    process.kill(s.pid, 'SIGTERM');
    return { ok: true, msg: `closed ${s.agent} in ${path.basename(s.cwd || '')} (pid ${s.pid})` };
  } catch (err) {
    return { ok: false, msg: `couldn't close pid ${s.pid}: ${err.code || err.message}` };
  }
}
