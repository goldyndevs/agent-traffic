'use strict';
// Dedupe guard: blocks a command when the exact same command is already running
// (or queued) in the same directory, typically started by another agent session
// or by this agent earlier as a background task. Two `npm install`s in one
// project can corrupt node_modules; two identical builds just waste the machine.
// Only commands that pass through a gate (heavy jobs, dev servers) are tracked.

const state = require('../core/state');

function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function check(ctx) {
  if (!ctx.cfg.dedupe.enabled || ctx.bypass) return null;
  // Only gated commands (heavy jobs, dev servers) ever have a record to match,
  // so don't take the registry lock for every `ls`.
  if (!ctx.heavy && !ctx.server) return null;
  const s = state.snapshot();
  const all = [
    ...s.holders.map((r) => [r, 'running']),
    ...s.queue.map((r) => [r, 'queued']),
    ...s.servers.map((r) => [r, 'running as a server']),
  ];
  const hit = all.find(([r]) => r.key === ctx.key);
  if (!hit) return null;
  const [rec, what] = hit;
  return {
    deny: `agent-traffic: this exact command is already ${what} in this directory `
      + `(pid ${rec.pid}, started ${fmtAge(Date.now() - rec.since)} ago, probably by another agent session or an earlier background task). `
      + 'Running it again would duplicate the work and can corrupt shared output (node_modules, build dirs). '
      + 'Wait for it to finish and reuse its result, or rerun afterwards if your changes need a fresh run. '
      + ctx.bypassNote,
  };
}

module.exports = { check };
