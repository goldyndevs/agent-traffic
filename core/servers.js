'use strict';
// Recognizes commands that start a dev server and works out the port it will use.
// Shared by the port, background and conflict guards.

const fs = require('fs');
const path = require('path');
const { CMD, END, executedPart } = require('./command');

// Dev servers and their default ports (null: no fixed default).
const SERVERS = [
  { label: 'vite', port: 5173, pattern: `${CMD}vite(?=\\s|$|[;&|)])(?!\\s+(build|optimize|preview)\\b)` },
  { label: 'vite-preview', port: 4173, pattern: `${CMD}vite\\s+preview\\b` },
  { label: 'next', port: 3000, pattern: `${CMD}next\\s+(dev|start)\\b` },
  { label: 'nuxt', port: 3000, pattern: `${CMD}(nuxt|nuxi)\\s+(dev|preview|start)\\b` },
  { label: 'astro', port: 4321, pattern: `${CMD}astro\\s+(dev|preview)\\b` },
  { label: 'angular', port: 4200, pattern: `${CMD}ng\\s+serve\\b` },
  { label: 'cra', port: 3000, pattern: '\\breact-scripts\\s+start\\b' },
  { label: 'metro', port: 8081, pattern: `${CMD}expo\\s+start\\b|\\breact-native\\s+start\\b` },
  { label: 'webpack-dev-server', port: 8080, pattern: '\\bwebpack(-dev-server\\b|\\s+serve\\b)' },
  { label: 'storybook', port: 6006, pattern: '\\bstorybook\\s+dev\\b' },
  { label: 'django', port: 8000, pattern: '\\bmanage\\.py\\s+runserver\\b' },
  { label: 'flask', port: 5000, pattern: `${CMD}flask\\s+run\\b` },
  { label: 'uvicorn', port: 8000, pattern: `${CMD}(uvicorn|gunicorn)${END}` },
  { label: 'rails', port: 3000, pattern: '\\brails\\s+(s|server)\\b' },
  { label: 'laravel', port: 8000, pattern: '\\bartisan\\s+serve\\b' },
  { label: 'http.server', port: 8000, pattern: '\\bhttp\\.server\\b' },
  { label: 'php', port: null, pattern: '\\bphp\\s+-S\\b' },
  { label: 'dotnet', port: null, pattern: '\\bdotnet\\s+(run|watch)\\b' },
];

const NODE_SERVERS = new Set(['vite', 'vite-preview', 'next', 'nuxt', 'astro', 'angular', 'cra', 'metro', 'webpack-dev-server', 'storybook']);

const NPM_SCRIPT = /\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?(dev|start|serve|preview|storybook)\b/;

// Explicit port in the raw command (flags may be quoted, so not executedPart).
function flagPort(raw) {
  const res = [
    /--(?:http-)?port(?:=|\s+)['"]?(\d{2,5})\b/,
    /(?:^|\s)-p(?:=|\s+)?['"]?(\d{2,5})\b/,
    /\bPORT\s*=\s*['"]?(\d{2,5})\b/,
    /runserver\s+(?:\S*:)?(\d{2,5})\b/,
    /--urls(?:=|\s+)['"]?\S*?:(\d{2,5})/,
    /(?:\s-b|--bind)(?:=|\s+)['"]?\S*?:(\d{2,5})/,
    /http\.server\s+(\d{2,5})\b/,
    /php\s+-S\s+\S*:(\d{2,5})/,
  ];
  for (const re of res) {
    const m = raw.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function vitePort(dir) {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
    try {
      const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/server\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})/);
      if (m) return Number(m[1]);
    } catch { /* not there */ }
  }
  return null;
}

function packageScript(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts[name] || null; } catch { return null; }
}

// Returns { label, port, known } if the command starts a dev server, else null.
// known: the server itself was recognized (not just an npm script name).
function detectServer(raw, dir, depth = 0) {
  const cmd = executedPart(raw);
  const script = depth === 0 && cmd.match(NPM_SCRIPT);
  if (script) {
    const body = packageScript(dir, script[2]);
    const inner = body ? detectServer(body, dir, 1) : null;
    return {
      label: inner ? inner.label : `${script[1]}-${script[2]}`, // no spaces: it is passed as a CLI arg
      port: flagPort(raw) || (body && flagPort(body)) || (inner && inner.port) || null,
      known: !!inner,
      script: script[2],
    };
  }
  const hit = SERVERS.find((s) => new RegExp(s.pattern).test(cmd));
  if (!hit) return null;
  const port = flagPort(raw) || (hit.label === 'vite' && vitePort(dir)) || hit.port;
  return { label: hit.label, port, known: true };
}

module.exports = { detectServer, packageScript, NODE_SERVERS };
