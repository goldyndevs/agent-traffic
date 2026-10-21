'use strict';
// Conflict guard: different commands that break each other when they run in the
// same project at once. Dedupe only catches identical commands; this catches e.g.
//   npm install   while a build/test of that project runs (node_modules swapped mid-run)
//   next build    while next dev runs (both write .next)
//   dotnet build  while the app runs via dotnet run (output dlls are locked)
// Running commands are known from the registry (gated heavy jobs and dev servers).

const state = require('../core/state');
const { normCwd } = require('../core/command');

function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? `${Math.round(ms / 1000)}s` : `${m} min`;
}

// Returns { deny } or { warn } for `inc` (incoming) against `run` (running), or null.
function clash(inc, run) {
  if (inc.eco !== run.eco) return null;
  if (inc.eco === 'node') {
    if (inc.kind === 'install' && ['install', 'build', 'test'].includes(run.kind)) {
      return { deny: 'installing packages now would swap node_modules under it and break it halfway. Wait for it to finish, then run this.' };
    }
    if (inc.kind === 'install' && run.kind === 'server') {
      return { warn: 'the dev server keeps running while packages change; restart it afterwards if it misbehaves.' };
    }
    if (['build', 'test'].includes(inc.kind) && run.kind === 'install') {
      return { deny: 'packages are being installed, so node_modules is incomplete right now. Wait for the install to finish, then run this.' };
    }
    if (inc.kind === 'build' && inc.fw === 'next' && run.kind === 'server' && run.fw === 'next') {
      return { deny: 'next build and the running next dev server both write .next, so building now corrupts the dev server. Stop the dev server first (or build after you are done with it).' };
    }
    if (inc.kind === 'server' && inc.fw === 'next' && run.kind === 'build' && run.fw === 'next') {
      return { deny: 'next build is writing .next right now. Wait for it to finish, then start the dev server.' };
    }
  }
  if (inc.eco === 'dotnet') {
    if (run.kind === 'server' && inc.kind !== 'server') {
      return { deny: 'the running app locks the build output (bin/obj dlls), so this would fail. Stop the running app first.' };
    }
    if (['build', 'install'].includes(run.kind)) {
      return { deny: 'it is writing obj/bin right now. Wait for it to finish, then run this.' };
    }
  }
  return null;
}

function check(ctx) {
  if (!ctx.cfg.conflict.enabled || ctx.bypass || !ctx.desc) return null;
  const s = state.snapshot();
  const here = normCwd(ctx.proj);
  const running = [...s.holders, ...s.queue, ...s.servers]
    .filter((r) => r.eco && r.proj && normCwd(r.proj) === here && r.key !== ctx.key);
  const warns = [];
  for (const r of running) {
    const c = clash(ctx.desc, r);
    if (!c) continue;
    const where = normCwd(r.dir || r.proj) === normCwd(ctx.dir) ? 'in this project' : `in this workspace (${r.dir || r.proj})`;
    const who = `\`${(r.cmd || r.label).split('\n')[0]}\` (${r.kind}, pid ${r.pid}, started ${fmtAge(Date.now() - r.since)} ago) is running ${where}`;
    if (c.deny) {
      return { deny: `agent-traffic: ${who}; ${c.deny} ${ctx.bypassNote}` };
    }
    warns.push(`agent-traffic: ${who}; ${c.warn}`);
  }
  return warns.length ? { context: warns.join('\n') } : null;
}

module.exports = { clash, check };
