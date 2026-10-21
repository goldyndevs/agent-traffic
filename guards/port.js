'use strict';
// Port guard: stops an agent from starting a dev server on a port that is already
// taken. The common case is an agent (or another session) that already started
// this project's server and forgot; Vite/Next then silently move to the next port
// and you end up with duplicate servers. The agent is told who holds the port
// and whether to reuse it or pick another one.
// Every detected dev server is also registered (`agent-traffic register`) so later
// checks can say which project and command own a port.

const net = require('net');
const { spawnSync } = require('child_process');
const state = require('../core/state');
const { normCwd } = require('../core/command');

function probe(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(400, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Dev servers often bind only ::1 ("localhost" on recent Node), so try both.
async function inUse(port) {
  const r = await Promise.all([probe('127.0.0.1', port), probe('::1', port)]);
  return r.some(Boolean);
}

async function freePortNear(port) {
  for (let p = port + 1; p < port + 20; p++) if (!(await inUse(p))) return p;
  return null;
}

// Best-effort "who listens on this port" from the OS.
function osOwner(port) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 3000 }).stdout
        + spawnSync('netstat', ['-ano', '-p', 'TCPv6'], { encoding: 'utf8', timeout: 3000 }).stdout;
      const line = out.split(/\r?\n/).find((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l.trim().split(/\s+/)[1] + ' '));
      if (!line) return null;
      const pid = Number(line.trim().split(/\s+/).pop());
      const csv = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 3000 }).stdout;
      const name = (csv.match(/^"([^"]+)"/) || [])[1];
      return { pid, name: name || 'unknown' };
    }
    const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', timeout: 3000 }).stdout;
    const pid = (out.match(/^p(\d+)/m) || [])[1];
    const name = (out.match(/^c(.+)$/m) || [])[1];
    return pid ? { pid: Number(pid), name: name || 'unknown' } : null;
  } catch { return null; }
}

async function check(ctx) {
  if (!ctx.cfg.port.enabled) return null;
  const srv = ctx.server;
  if (!srv) return null;
  const gate = { sub: 'register', required: false, args: `--label ${srv.label}${srv.port ? ` --port ${srv.port}` : ''}` };
  if (ctx.bypass || !srv.port || !(await inUse(srv.port))) return { gate };

  const port = srv.port;
  const free = await freePortNear(port);
  const pickOther = free ? `start it on a free port instead, e.g. ${free} (pass the port flag your tool uses)` : 'start it on another free port';
  const rec = state.snapshot().servers.find((s) => s.port === port);
  let msg;
  if (rec && normCwd(rec.dir) === normCwd(ctx.dir)) {
    msg = `agent-traffic: a dev server for THIS project is already running on port ${port} `
      + `(${rec.label}, started by an agent ${Math.round((Date.now() - rec.since) / 60000)} min ago${rec.cmd ? `: \`${rec.cmd.split('\n')[0]}\`` : ''}, pid ${rec.pid}). `
      + `Reuse it at http://localhost:${port} instead of starting another copy. If you must restart it (e.g. config change), stop pid ${rec.pid} first.`;
  } else if (rec) {
    msg = `agent-traffic: port ${port} is used by a dev server of ANOTHER project (${rec.dir}, ${rec.label}, pid ${rec.pid}). `
      + `Do not stop it; ${pickOther}.`;
  } else {
    const o = osOwner(port);
    msg = `agent-traffic: port ${port} is already in use${o ? ` by ${o.name} (pid ${o.pid})` : ''}. `
      + `If that is this project's dev server, reuse it at http://localhost:${port}; otherwise ${pickOther}. `
      + 'Starting anyway would fail or silently move to another port and leave duplicate servers running.';
  }
  return { deny: `${msg} ${ctx.bypassNote}` };
}

module.exports = { inUse, osOwner, check };
