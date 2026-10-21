'use strict';
// Helpers for reading a shell command the way the guards need it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// A bare tool name only counts in command position: start of line, after ; & | (,
// after a launcher (npx, yarn, python -m...) or a path (./gradlew). So
// `git add gradlew` or `git log --grep jest` are not commands being run.
const CMD = '(^|[;&|(\\n]\\s*|\\b(npx|bunx|pnpx|exec|yarn|pnpm|bun)\\s+|\\s(-m|/c)\\s+|[/\\\\])';
const END = '(?=\\s|$|[;&|)])';

// Drops text that is data rather than something executed: heredoc bodies, quoted
// strings and comments. Stops `git commit -m "fix gradlew"`, `grep "npm run build"`
// or a file written via heredoc from being treated as a build.
function executedPart(command) {
  return command
    .replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, ' ')
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/(^|\s)#.*$/gm, ' ');
}

function normCwd(cwd) {
  let p = path.resolve(cwd || process.cwd());
  // One dir, one key: resolve symlinks (macOS /var -> /private/var) when it exists.
  try { p = fs.realpathSync.native(p); } catch { /* not there (yet) */ }
  p = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// Identity of "the same command in the same place", used to spot duplicates.
function commandKey(cwd, command) {
  const norm = command.trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha1').update(`${normCwd(cwd)}\0${norm}`).digest('hex').slice(0, 16);
}

// Directory the command really runs in, following a leading `cd dir &&` / `cd dir;`.
function effectiveDir(command, cwd) {
  const m = command.match(/^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(&&|;|\n)/);
  if (!m) return cwd;
  let dir = m[2] || m[3] || m[4];
  // Git Bash style /c/foo -> C:/foo
  if (process.platform === 'win32') dir = dir.replace(/^\/([a-zA-Z])\//, '$1:/');
  return path.resolve(cwd, dir);
}

module.exports = { CMD, END, executedPart, normCwd, commandKey, effectiveDir };
