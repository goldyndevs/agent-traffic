'use strict';
// Machine-wide registry shared by every guard. Zero dependencies.
//
// State lives in ~/.agent-traffic (override with AGENT_TRAFFIC_HOME) so every
// agent session on the machine, and any plugin version, sees the same picture.
//   holders/<pid>.json  heavy jobs running (own queue capacity)
//   queue/<pid>.json    heavy jobs waiting, served strictly FIFO; pid is the waiter
//   servers/<pid>.json  dev servers started by agents (port, project)
//   lock                short-lived mutex file holding its owner's pid
// For holders/servers, pid is the process whose lifetime is the job: usually the
// agent's shell. A record is dropped as soon as its pid is dead, so crashes never
// leak anything.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.AGENT_TRAFFIC_HOME || path.join(os.homedir(), '.agent-traffic');
const HOLDERS = path.join(HOME, 'holders');
const QUEUE = path.join(HOME, 'queue');
const SERVERS = path.join(HOME, 'servers');
const LOCK = path.join(HOME, 'lock');

const STALE_LOCK_MS = 30000; // only if the owner pid looks alive (pid reuse, frozen box)
const STALE_RECORD_MS = 24 * 60 * 60 * 1000; // guards against pid reuse

function ensureDirs() {
  for (const d of [HOLDERS, QUEUE, SERVERS]) fs.mkdirSync(d, { recursive: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function withLock(fn) {
  ensureDirs();
  for (;;) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      try {
        const owner = Number(fs.readFileSync(LOCK, 'utf8'));
        if ((owner && !isAlive(owner)) || Date.now() - fs.statSync(LOCK).mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(LOCK);
        }
      } catch { /* being created or already cleaned */ }
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(LOCK); } catch { /* ignore */ } }
}

// Reads all records in dir, deleting dead or stale ones. Call under lock.
function readLive(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rec = null; }
    if (!rec || !isAlive(rec.pid) || Date.now() - rec.since > STALE_RECORD_MS) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      continue;
    }
    out.push(rec);
  }
  return out.sort((a, b) => a.since - b.since || a.pid - b.pid);
}

function snapshot() {
  return withLock(() => ({ holders: readLive(HOLDERS), queue: readLive(QUEUE), servers: readLive(SERVERS) }));
}

const recFile = (dir, pid) => path.join(dir, `${pid}.json`);

// Frees everything held on behalf of `owner`, plus this process's queue entry.
function release(owner = process.pid) {
  for (const dir of [HOLDERS, SERVERS]) {
    try { fs.unlinkSync(recFile(dir, owner)); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(recFile(QUEUE, process.pid)); } catch { /* ignore */ }
}

const freeMemMB = () => Math.round(os.freemem() / 1048576);

module.exports = {
  HOME, HOLDERS, QUEUE, SERVERS, ensureDirs, sleepSync, isAlive, withLock, readLive, snapshot, recFile, release, freeMemMB,
};
