'use strict';
// Decides whether a gated command may be auto-approved. Claude Code checks
// permission rules against the rewritten command, so the prepended gate line
// would otherwise cost the user an extra prompt even for commands they already
// allow. We return "allow" only when we can prove the ORIGINAL command is covered
// by one of the user's own allow rules; anything ambiguous keeps the normal
// prompt. Claude Code still evaluates deny and ask rules whatever we return.
//
// Deliberately narrower than Claude Code's own matcher:
//   - the command must be one simple command, optionally after `cd <dir> &&`
//     where dir stays inside the project (no ; | & > < ` $( newlines)
//   - rules: bare `Bash` / `Bash(*)`, exact `Bash(cmd)`, or a trailing prefix
//     `Bash(cmd:*)` / `Bash(cmd *)`; any other wildcard never matches
//   - only in the default and acceptEdits permission modes

const fs = require('fs');
const os = require('os');
const path = require('path');
const { normCwd } = require('./command');

const MODES = new Set(['default', 'acceptEdits']);
// No separators, redirects, substitutions or newlines (\s would allow newlines).
const SIMPLE = /^[\w \t\-./:=@%+,'"\\~]+$/;

function settingsFiles(projectDir) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [
    path.join(home, 'settings.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ];
}

function allowRules(tool, projectDir) {
  const rules = [];
  for (const f of settingsFiles(projectDir)) {
    try {
      const allow = JSON.parse(fs.readFileSync(f, 'utf8')).permissions.allow || [];
      for (const r of allow) if (typeof r === 'string' && (r === tool || r.startsWith(`${tool}(`))) rules.push(r);
    } catch { /* missing or unreadable: contributes nothing */ }
  }
  return rules;
}

// Original command reduced to the part rules are matched against, or null if it
// is not a form we can reason about safely.
function simpleCommand(command, cwd, projectDir) {
  let cmd = command.trim();
  const cd = cmd.match(/^cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&\s*(.+)$/s);
  if (cd) {
    let dir = cd[2] || cd[3] || cd[4];
    if (process.platform === 'win32') dir = dir.replace(/^\/([a-zA-Z])\//, '$1:/');
    const target = normCwd(path.resolve(cwd, dir));
    const root = normCwd(projectDir);
    if (target !== root && !target.startsWith(root + '/')) return null;
    cmd = cd[5].trim();
  }
  if (!cmd || !SIMPLE.test(cmd)) return null;
  return cmd.replace(/\s+/g, ' ');
}

function ruleMatches(rule, tool, cmd) {
  if (rule === tool || rule === `${tool}(*)`) return true;
  const body = rule.slice(tool.length + 1, -1);
  const ci = tool === 'PowerShell'; // PowerShell rules are case-insensitive
  const eq = (a, b) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  const prefix = body.endsWith(':*') ? body.slice(0, -2) : body.endsWith(' *') ? body.slice(0, -2) : null;
  if (prefix !== null) {
    if (prefix.includes('*') || !prefix.trim()) return false;
    return eq(cmd, prefix) || eq(cmd.slice(0, prefix.length + 1), `${prefix} `);
  }
  return !body.includes('*') && eq(cmd, body.trim().replace(/\s+/g, ' '));
}

// Returns the matching user rule if the gated command may be auto-approved.
function coveredBy(ctx) {
  if (!MODES.has(ctx.permissionMode)) return null;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || ctx.cwd;
  const cmd = simpleCommand(ctx.command, ctx.cwd, projectDir);
  if (!cmd) return null;
  return allowRules(ctx.tool, projectDir).find((r) => ruleMatches(r, ctx.tool, cmd)) || null;
}

module.exports = { coveredBy, simpleCommand, ruleMatches };
