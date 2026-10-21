#!/usr/bin/env node
'use strict';
// agent-traffic CLI.
//   agent-traffic.js acquire --owner PID [--weight N] [--label X] [--max-wait SEC] [--key K] [--desc B64]
//       Waits for a heavy-job slot held on behalf of PID (the agent's shell),
//       lowers PID's priority, and returns. The slot frees when PID exits.
//       Used by the hook: `node agent-traffic.js acquire --owner <shell> || exit $?` + original command.
//   agent-traffic.js register --owner PID --label X [--port N] [--proj B64] [--key K] [--desc B64]
//       Records a dev server started by PID; dropped when PID exits.
//   agent-traffic.js run [--weight N] [--label X] [--max-wait SEC] -- <command>
//       Heavy queue for manual use / other agents: waits, runs, frees.
//   agent-traffic.js status
// Exit code 75 means the machine stayed busy for max-wait and nothing ran.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const state = require('../core/state');
const { loadConfig } = require('../core/config');
const heavy = require('../guards/heavy');

const EXIT_BUSY = 75;
const SELF = path.resolve(__filename).replace(/\\/g, '/');

function parseArgs(argv) {
  const opts = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else opts.rest.push(a);
  }
  return opts;
}

const b64 = (s) => (s ? Buffer.from(s, 'base64').toString('utf8') : null);

function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function oneLine(cmd, max = 80) {
  const s = String(cmd || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function cpuPercent(sampleMs = 300) {
  const take = () => os.cpus().reduce((acc, c) => {
    const t = Object.values(c.times).reduce((a, b) => a + b, 0);
    return { idle: acc.idle + c.times.idle, total: acc.total + t };
  }, { idle: 0, total: 0 });
  const a = take();
  state.sleepSync(sampleMs);
  const b = take();
  const total = b.total - a.total;
  return total > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / total)) : 0;
}

function renderStatus(cfg, snap) {
  const h = cfg.heavy;
  const used = snap.holders.reduce((s, x) => s + x.weight, 0);
  const memUsed = Math.round(100 * (1 - os.freemem() / os.totalmem()));
  const lines = [
    `agent-traffic: capacity ${used}/${h.capacity} used | CPU ${cpuPercent()}% | RAM ${memUsed}% used, `
      + `${(state.freeMemMB() / 1024).toFixed(1)} GB free (jobs share only above ${(h.minFreeMemMB / 1024).toFixed(1)} GB) | ${os.cpus().length} cores`,
  ];
  const now = Date.now();
  const cmd = (r) => (r.cmd ? ': ' + oneLine(r.cmd) : '');
  lines.push(snap.holders.length ? 'Running:' : 'Running: none');
  for (const r of snap.holders) lines.push(`  [${r.label} w${r.weight}] pid ${r.pid}, ${fmtAge(now - r.since)}, in ${r.cwd}${cmd(r)}`);
  if (snap.queue.length) lines.push('Waiting:');
  snap.queue.forEach((r, i) => lines.push(`  #${i + 1} [${r.label} w${r.weight}] pid ${r.pid}, waited ${fmtAge(now - r.since)}, in ${r.cwd}${cmd(r)}`));
  if (snap.servers && snap.servers.length) {
    lines.push('Dev servers:');
    for (const r of snap.servers) lines.push(`  [${r.label}${r.port ? ` :${r.port}` : ''}] pid ${r.pid}, up ${fmtAge(now - r.since)}, in ${r.dir}${cmd(r)}`);
  }
  return lines.join('\n');
}

function cmdStatus() {
  console.log(renderStatus(loadConfig(), state.snapshot()));
}

// Fields the dedupe and conflict guards match on (see hooks/pretooluse.js).
function projectInfo(opts) {
  return {
    key: opts.key || null,
    dir: b64(opts.dir) || process.cwd(),
    proj: b64(opts.proj) || b64(opts.dir) || process.cwd(),
    eco: opts.eco || null,
    kind: opts.kind || null,
    fw: opts.fw || null,
  };
}

// Shared by acquire and run: waits for a slot or exits 75.
function waitForSlot(opts, cmd, owner) {
  const cfg = loadConfig();
  const guess = cmd ? heavy.classify(cmd, cfg.heavy) : null;
  const job = {
    label: opts.label || (guess && guess.label) || 'heavy',
    weight: Number(opts.weight) || (guess && guess.weight) || 2,
    cmd,
    cwd: process.cwd(),
    ...projectInfo(opts),
  };
  // --max-wait 0 waits forever (used for background jobs).
  const maxWaitSec = opts['max-wait'] !== undefined ? Number(opts['max-wait']) : cfg.heavy.maxWaitSec;
  const maxWaitMs = maxWaitSec > 0 ? maxWaitSec * 1000 : Infinity;
  const waitText = maxWaitSec > 0 ? `waiting up to ${maxWaitSec}s` : 'waiting until a slot frees up';

  let announced = false;
  const r = heavy.acquire(job, cfg.heavy, maxWaitMs, (s) => {
    if (announced) return;
    announced = true;
    const pos = s.queue.findIndex((q) => q.pid === process.pid) + 1;
    const why = { capacity: 'not enough free capacity', ram: 'free RAM too low to run next to the current build', queue: 'jobs ahead in queue' }[s.why];
    console.error(`agent-traffic: machine busy (${why}), queued at #${pos} (${waitText})...`);
    console.error(renderStatus(cfg, s));
  }, owner);

  if (!r.ok) {
    r.queue = r.queue.filter((q) => q.pid !== process.pid); // we just left it
    console.log([
      `agent-traffic: BUSY. The machine stayed busy for ${maxWaitSec}s, so this command was NOT run.`,
      renderStatus(cfg, r),
      'Do not retry in a tight loop. Do other non-build work first, then retry the same command later.',
      `Check status anytime with: node "${SELF}" status`,
    ].join('\n'));
    process.exit(EXIT_BUSY);
  }
  if (announced) console.error('agent-traffic: slot acquired, starting.');
  return cfg;
}

function lowerPriority(pid) {
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
}

// Detached watcher frees the owner's records the moment it exits, so a recycled
// pid can never keep a dead job's slot or port.
function spawnWatcher(owner) {
  spawn(process.execPath, [__filename, 'watch', '--owner', String(owner)], {
    detached: true, stdio: 'ignore', windowsHide: true,
    cwd: state.HOME, // don't pin the project dir (Windows can't delete/rename a dir in use)
  }).unref();
}

function ownerFrom(opts) {
  const owner = Number(opts.owner) || process.ppid;
  if (!state.isAlive(owner)) { console.error(`agent-traffic: owner pid ${owner} not found`); process.exit(2); }
  return owner;
}

function cmdAcquire(opts) {
  const owner = ownerFrom(opts);
  process.on('exit', () => { try { fs.unlinkSync(state.recFile(state.QUEUE, process.pid)); } catch { /* ignore */ } });
  const cfg = waitForSlot(opts, b64(opts.desc), owner); // desc: display only
  if (cfg.heavy.lowPriority) lowerPriority(owner); // inherited by the build the shell starts next
  spawnWatcher(owner);
}

function cmdRegister(opts) {
  const owner = ownerFrom(opts);
  const info = projectInfo(opts);
  const rec = {
    pid: owner, label: opts.label || 'server', port: Number(opts.port) || null,
    ...info, cmd: b64(opts.desc), since: Date.now(),
  };
  state.withLock(() => fs.writeFileSync(state.recFile(state.SERVERS, owner), JSON.stringify(rec)));
  spawnWatcher(owner);
}

// A dev server can outlive the shell that started it (e.g. a background task is
// stopped but its server process keeps running). Then the record moves to the
// process now listening on the port, so the port guard can still say whose it is.
async function adoptOrphanServer(owner) {
  const port = require('../guards/port');
  let rec;
  try { rec = JSON.parse(fs.readFileSync(state.recFile(state.SERVERS, owner), 'utf8')); } catch { return null; }
  if (!rec.port || !(await port.inUse(rec.port))) return null;
  const o = port.osOwner(rec.port);
  if (!o || o.pid === owner || !state.isAlive(o.pid)) return null;
  state.withLock(() => {
    fs.writeFileSync(state.recFile(state.SERVERS, o.pid), JSON.stringify({ ...rec, pid: o.pid, orphanOf: owner }));
    try { fs.unlinkSync(state.recFile(state.SERVERS, owner)); } catch { /* ignore */ }
  });
  return o.pid;
}

function cmdWatch(opts) {
  let owner = Number(opts.owner);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || state.isAlive(owner)) return;
    busy = true;
    const heir = await adoptOrphanServer(owner).catch(() => null);
    if (heir) { owner = heir; busy = false; return; } // keep watching the server itself
    state.release(owner);
    clearInterval(timer);
  }, 500);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

function cmdRun(opts) {
  const cmd = opts.rest.join(' ');
  if (!cmd.trim()) { console.error('agent-traffic: nothing to run'); process.exit(2); }
  process.on('exit', () => state.release());
  const cfg = waitForSlot(opts, cmd, process.pid);
  if (cfg.heavy.lowPriority) lowerPriority(0);
  const child = spawn(cmd, { shell: true, stdio: 'inherit' });
  const stop = () => killTree(child);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  child.on('error', (e) => { console.error(`agent-traffic: failed to start: ${e.message}`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code !== null ? code : signal ? 128 + (os.constants.signals[signal] || 1) : 1));
}

const [sub, ...argv] = process.argv.slice(2);
const opts = parseArgs(argv);
if (sub === 'acquire') cmdAcquire(opts);
else if (sub === 'register') cmdRegister(opts);
else if (sub === 'watch') cmdWatch(opts);
else if (sub === 'run') cmdRun(opts);
else if (sub === 'status') cmdStatus();
else {
  console.error('usage: agent-traffic.js run [--weight N] [--label X] [--max-wait SEC] -- <command>\n'
    + '       agent-traffic.js acquire --owner PID [--weight N] [--label X] [--max-wait SEC]\n'
    + '       agent-traffic.js register --owner PID --label X [--port N]\n'
    + '       agent-traffic.js status');
  process.exit(2);
}
