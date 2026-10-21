'use strict';
// Git guard: several agents in ONE working tree share the branch, the index and
// every uncommitted file. A branch switch, stash, hard reset, clean, rebase/pull
// or "add everything" by one agent then silently moves, discards or commits
// another agent's work. When another session has been active in the same working
// tree recently, such commands are blocked with a suggestion (own files only, or
// a separate `git worktree`). Read-only git commands are never touched.

const path = require('path');
const { executedPart } = require('../core/command');
const { repoRoot } = require('../core/project');
const sessions = require('../core/sessions');

// Each entry: [test on the args after `git <sub>`, what it does to other agents].
const OPS = {
  checkout: [() => true, 'switches the branch (or overwrites files) under the other agent'],
  switch: [() => true, 'switches the branch under the other agent'],
  stash: [(a) => !/^\s*(list|show)\b/.test(a), "stashes away or re-applies the other agent's uncommitted changes"],
  reset: [(a) => /--(hard|merge|keep)\b/.test(a), "discards the other agent's uncommitted changes"],
  clean: [(a) => /(^|\s)-\w*f|--force\b/.test(a), "deletes the other agent's new, not yet committed files"],
  restore: [() => true, "discards the other agent's changes to those files"],
  rebase: [() => true, 'rewrites the branch and working tree under the other agent'],
  merge: [() => true, 'changes the working tree under the other agent'],
  pull: [() => true, 'changes the working tree under the other agent'],
  'cherry-pick': [() => true, 'changes the working tree under the other agent'],
  revert: [() => true, 'changes the working tree under the other agent'],
  add: [(a) => /(^|\s)(-A|--all|\.|:\/|-u|--update)(\s|$)/.test(a), "stages the other agent's half-done changes together with yours"],
  commit: [(a) => /(^|\s)(-\w*a\w*|--all)(\s|$)/.test(a), "commits the other agent's half-done changes together with yours"],
};

// Returns { sub, effect, cwd } for the first risky git command, or null.
function riskyGit(command, cwd) {
  const cmd = executedPart(command);
  const re = /(^|[;&|(\n]\s*)git\s+((?:-C\s+(\S+)\s+|-c\s+\S+\s+)*)([\w-]+)([^;&|\n]*)/g;
  let m;
  while ((m = re.exec(cmd))) {
    const op = OPS[m[4]];
    if (op && op[0](m[5])) return { sub: m[4], effect: op[1], cwd: m[3] ? path.resolve(cwd, m[3]) : cwd };
  }
  return null;
}

function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : `${m} min ago`;
}

function check(ctx) {
  const g = ctx.cfg.git;
  if (!g.enabled || ctx.bypass) return null;
  const risky = riskyGit(ctx.command, ctx.dir);
  if (!risky) return null;
  const root = repoRoot(risky.cwd);
  if (!root) return null;
  const others = sessions.othersIn(root, ctx.sessionId, g.activeWindowMin * 60000);
  if (!others.length) return null;
  const o = others[0];
  const name = path.basename(root);
  const tip = ['add', 'commit'].includes(risky.sub)
    ? 'Stage and commit only your own files by path (git add <file>...; git commit -m ... -- <file>...).'
    : `Coordinate with the user first, or do this in a separate working tree: git worktree add ../${name}-<task> -b <branch>.`;
  return {
    deny: `agent-traffic: another agent session (${String(o.id).slice(0, 8)}, last active ${fmtAge(Date.now() - o.at)}: ${o.what}) `
      + `is working in this same working tree (${root}${others.length > 1 ? `, plus ${others.length - 1} more` : ''}). `
      + `\`git ${risky.sub}\` here ${risky.effect}. ${tip} ${ctx.bypassNote}`,
  };
}

module.exports = { riskyGit, check };
