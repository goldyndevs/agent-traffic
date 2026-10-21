#!/usr/bin/env node
'use strict';
// Session activity for the git guard.
//   PostToolUse (Edit/Write/MultiEdit/NotebookEdit): this session touched a file
//     in that git working tree, so it may have uncommitted work there.
//   SessionEnd: the session is gone; forget it.
// Never blocks anything and never prints.

const path = require('path');
const { repoRoot } = require('../core/project');
const sessions = require('../core/sessions');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    if (process.env.AGENT_TRAFFIC_DISABLE === '1') return;
    const input = JSON.parse(raw);
    if (input.hook_event_name === 'SessionEnd') return sessions.end(input.session_id);
    const ti = input.tool_input || {};
    const file = ti.file_path || ti.notebook_path;
    if (!file) return;
    const abs = path.resolve(input.cwd || process.cwd(), file);
    sessions.touch(input.session_id, repoRoot(path.dirname(abs)), `${input.tool_name} ${path.basename(abs)}`);
  } catch { /* best effort */ }
});
