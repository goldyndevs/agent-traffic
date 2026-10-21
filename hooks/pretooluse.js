#!/usr/bin/env node
'use strict';
// PreToolUse hook for Bash/PowerShell. Runs every guard on the command:
//   port, dedupe, conflict, git  may deny it with a reason the agent can act on
//   background                   moves never-ending commands to the background
//   port, heavy                  may prepend a gate line (register a dev server /
//                                wait for a heavy-job slot); the original command
//                                stays verbatim and runs in the agent's own shell
// It also records that this session is active in this git working tree (for the
// git guard). Any internal error lets the command through untouched.

const path = require('path');
const { loadConfig } = require('../core/config');
const { commandKey, effectiveDir } = require('../core/command');
const { coveredBy } = require('../core/permissions');
const { detectServer } = require('../core/servers');
const { describe, projectRoot, repoRoot } = require('../core/project');
const sessions = require('../core/sessions');
const { classify } = require('../guards/heavy');
const guards = ['port', 'dedupe', 'conflict', 'git', 'background', 'heavy'].map((g) => require(`../guards/${g}`));

const BYPASS = /AGENT_TRAFFIC_ALLOW=1|\$env:AGENT_TRAFFIC_ALLOW\s*=\s*['"]?1/;

function out(hookSpecificOutput) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...hookSpecificOutput } }));
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

async function main(raw) {
  if (process.env.AGENT_TRAFFIC_DISABLE === '1') return;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if ((tool !== 'Bash' && tool !== 'PowerShell') || typeof ti.command !== 'string') return;
  if (/agent-traffic\.js"?\s+(acquire|register|run)\b/.test(ti.command)) return; // already gated

  const ps = tool === 'PowerShell';
  const cwd = input.cwd || process.cwd();
  const dir = effectiveDir(ti.command, cwd);
  const server = detectServer(ti.command, dir);
  const desc = describe(ti.command, dir, server);
  const cfg = loadConfig();
  const hint = ps ? '`$env:AGENT_TRAFFIC_ALLOW=1; `' : '`AGENT_TRAFFIC_ALLOW=1 `';
  const ctx = {
    tool,
    sessionId: input.session_id,
    permissionMode: input.permission_mode,
    command: ti.command,
    input: ti,
    cwd,
    dir,
    proj: projectRoot(dir, desc && desc.eco), // what conflicting commands are compared on
    server,
    desc,
    heavy: cfg.heavy.enabled ? classify(ti.command, cfg.heavy) : null,
    cfg,
    bypass: BYPASS.test(ti.command),
    // Worded so agents ask instead of overriding on their own.
    bypassNote: `Do not override this on your own. Only if the user explicitly tells you to, prefix the command with ${hint}.`,
  };
  ctx.key = commandKey(cwd, ti.command);

  const results = [];
  try {
    for (const g of guards) {
      const r = await g.check(ctx);
      if (r && r.deny) return out({ permissionDecision: 'deny', permissionDecisionReason: r.deny });
      if (r) results.push(r);
    }
  } finally {
    try { sessions.touch(ctx.sessionId, repoRoot(dir), `${tool}: ${ti.command.split('\n')[0].slice(0, 80)}`); } catch { /* best effort */ }
  }
  if (!results.length) return;

  const context = results.map((r) => r.context).filter(Boolean).join('\n');
  const gates = results.filter((r) => r.gate);
  let updatedInput = { ...ti };
  if (gates.length) {
    const root = (process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..')).replace(/\\/g, '/');
    const d = ctx.desc || {};
    const common = `--key ${ctx.key} --desc '${b64(ti.command.slice(0, 200))}' --dir '${b64(dir)}' --proj '${b64(ctx.proj)}'`
      + (d.eco ? ` --eco ${d.eco} --kind ${d.kind}${d.fw ? ` --fw ${d.fw}` : ''}` : '');
    // Git Bash $$ is an msys pid; /proc/$$/winpid is the real Windows pid of the shell.
    const owner = ps ? '$PID' : '"$(cat /proc/$$/winpid 2>/dev/null || echo $$)"';
    const lines = gates.map(({ gate }) => {
      const call = `node "${root}/bin/agent-traffic.js" ${gate.sub} ${gate.args} ${common} --owner ${owner}`;
      if (!gate.required) return call;
      return ps ? `${call}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` : `${call} || exit $?`;
    });
    // Trailing `(exit $?)` keeps bash from exec-ing the last command in place of the
    // shell (on Git Bash that gives it a new Windows pid, so the owner would look
    // dead and its slot/port record would be dropped early). Exit status is unchanged.
    const tail = ps ? '' : '\n(exit $?)';
    updatedInput.command = `${lines.join('\n')}\n${ti.command}${tail}`;
  }
  for (const r of results) if (r.edit) r.edit(updatedInput);

  // The gate line would cost an extra prompt; skip it only when the user's own
  // allow rule already covers the original command (see core/permissions.js).
  const rule = gates.length ? coveredBy(ctx) : null;
  const decision = rule
    ? { permissionDecision: 'allow', permissionDecisionReason: `agent-traffic: original command allowed by your rule ${rule}; only a coordination gate was added` }
    : {};
  out({ ...decision, updatedInput, ...(context ? { additionalContext: context } : {}) });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  main(raw).catch((e) => process.stderr.write(`agent-traffic hook error: ${e.message}\n`));
});
