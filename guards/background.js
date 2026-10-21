'use strict';
// Background guard: commands that never finish on their own (dev servers, watch
// modes, log tails...) are switched to run_in_background. Run in the foreground
// they block the agent until the tool timeout, wasting 2-10 minutes each time.
// Only the tool input changes; nothing is blocked.

const { CMD, END, executedPart } = require('../core/command');

const NEVER_ENDING = [
  // `-w` alone is too common (curl -w, grep -w, wc -w); only tsc's is a watch flag.
  { label: 'watch mode', pattern: '(^|\\s)--watch(\\s|=|$)|\\btsc\\b[^;&|\\n]*\\s-w(\\s|$)|\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?[\\w:-]*watch\\b' },
  { label: 'nodemon', pattern: `${CMD}nodemon${END}` },
  { label: 'log follow', pattern: '\\btail\\s+(-\\w*f|--follow)\\b|\\bkubectl\\s+logs\\b.*\\s(-f|--follow)\\b|\\bdocker\\s+(compose\\s+)?logs\\b.*\\s(-f|--follow)\\b' },
  { label: 'logcat', pattern: '\\badb\\s+logcat\\b(?![^;&|\\n]*\\s-d\\b)' },
  { label: 'docker compose up', pattern: '\\bdocker(\\s+compose|-compose)\\s+up\\b(?![^;&|\\n]*\\s(-d|--detach)\\b)' },
  { label: 'flutter run', pattern: '\\bflutter\\s+run\\b' },
  { label: 'emulator', pattern: `${CMD}emulator${END}(?![^;&|\\n]*-list-avds)` },
];

function check(ctx) {
  if (!ctx.cfg.background.enabled || ctx.input.run_in_background) return null;
  const cmd = executedPart(ctx.command);
  const srv = ctx.server;
  // npm start may be a CLI tool; trust it only when the script itself is a known server.
  const server = srv && srv.label !== 'dotnet' && (srv.known || ['dev', 'serve', 'storybook'].includes(srv.script));
  const hit = server ? { label: `${srv.label} dev server` } : NEVER_ENDING.find((r) => new RegExp(r.pattern).test(cmd));
  if (!hit) return null;
  ctx.background = true; // lets the heavy guard wait without a time limit
  return {
    edit(input) {
      input.run_in_background = true;
      delete input.timeout;
    },
    context: `agent-traffic: "${hit.label}" never finishes on its own, so it was started as a BACKGROUND task instead of blocking until the timeout. `
      + 'Read its output from the task output when you need it, and stop it when you are done.',
  };
}

module.exports = { check };
