'use strict';
// What a command does to its project: ecosystem (node/dotnet), kind
// (install/build/test/server) and framework, used to spot commands that clash
// inside one project. Also finds the git working tree a path belongs to.

const fs = require('fs');
const path = require('path');
const { CMD, END, executedPart } = require('./command');
const { packageScript, NODE_SERVERS } = require('./servers');

const NODE_INSTALL = new RegExp([
  '\\bnpm\\s+(install|i|ci|uninstall|un|rm|remove|update|up)\\b',
  '\\bpnpm\\s+(install|i|add|remove|rm|update|up)\\b',
  '\\byarn\\s+(install|add|remove|upgrade)\\b',
  '\\bbun\\s+(install|i|add|remove|rm|update)\\b',
].join('|'));
const NODE_BUILD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(next|vite|nuxt|nuxi|astro|ng|webpack|turbo|nx|remix|svelte-kit)\s+(run\s+)?build\b/;
const NODE_TEST = new RegExp(`\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b|${CMD}(jest|vitest)${END}|\\bplaywright\\s+test\\b|\\bcypress\\s+run\\b`);

// Returns { eco, kind, fw } or null. `server` is detectServer()'s result.
function describe(command, dir, server) {
  const cmd = executedPart(command);
  if (NODE_INSTALL.test(cmd)) return { eco: 'node', kind: 'install', fw: null };
  if (/\bdotnet\s+(restore|add\s+package|remove\s+package)\b/.test(cmd)) return { eco: 'dotnet', kind: 'install', fw: null };
  if (/\bdotnet\s+(run|watch)\b/.test(cmd)) return { eco: 'dotnet', kind: 'server', fw: null };
  if (/\bdotnet\s+(build|test|publish|clean|pack)\b/.test(cmd)) return { eco: 'dotnet', kind: 'build', fw: null };
  if (NODE_BUILD.test(cmd)) {
    const viaScript = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/.test(cmd) ? packageScript(dir, 'build') || '' : '';
    return { eco: 'node', kind: 'build', fw: /\bnext\s+build\b/.test(cmd + ' ' + viaScript) ? 'next' : null };
  }
  if (NODE_TEST.test(cmd)) return { eco: 'node', kind: 'test', fw: null };
  if (server && NODE_SERVERS.has(server.label)) return { eco: 'node', kind: 'server', fw: server.label === 'next' ? 'next' : null };
  if (server && /^(npm|pnpm|yarn|bun)-/.test(server.label)) return { eco: 'node', kind: 'server', fw: null };
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The unit whose files a command shares with other commands. For node that is the
// workspace root when inside an npm/yarn/pnpm workspace (an install at the root
// rewrites node_modules every package uses), else the nearest package.json dir.
// Other ecosystems: the directory itself.
function projectRoot(dir, eco) {
  if (eco !== 'node') return dir;
  let nearest = null;
  let workspace = null;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const pkg = readJson(path.join(d, 'package.json'));
    if (pkg && !nearest) nearest = d;
    if ((pkg && pkg.workspaces) || fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) workspace = d;
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) break; // stop at repo root
  }
  return workspace || nearest || dir;
}

// Root of the git working tree containing `dir` (a linked worktree has its own
// root, marked by a .git file), or null.
function repoRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

module.exports = { describe, projectRoot, repoRoot };
