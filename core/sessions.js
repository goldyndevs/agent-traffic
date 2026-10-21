'use strict';
// Which agent sessions are working in which git working tree, so the git guard
// can tell when a branch switch or reset would hit another agent's uncommitted
// work. Each session writes only its own file: sessions/<session_id>.json
//   { id, repos: { <root>: { at: <ms>, what: <last activity> } } }
// The file is removed by the SessionEnd hook; entries also age out.

const fs = require('fs');
const path = require('path');
const { HOME } = require('./state');
const { normCwd } = require('./command');

const DIR = path.join(HOME, 'sessions');
const fileOf = (id) => path.join(DIR, `${String(id).replace(/[^\w-]/g, '_')}.json`);

function touch(id, root, what) {
  if (!id || !root) return;
  fs.mkdirSync(DIR, { recursive: true });
  let rec = { id, repos: {} };
  try { rec = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { /* first touch */ }
  rec.repos[normCwd(root)] = { at: Date.now(), what: String(what).slice(0, 120) };
  const tmp = `${fileOf(id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, fileOf(id)); // atomic: readers never see half a file
}

function end(id) {
  try { fs.unlinkSync(fileOf(id)); } catch { /* already gone */ }
}

// A session whose SessionEnd never ran (crash, killed terminal) leaves its file
// behind; drop it once nothing in it is recent.
const FORGET_MS = 24 * 60 * 60 * 1000;

// Other sessions active in this working tree within windowMs, newest first.
function othersIn(root, selfId, windowMs) {
  const key = normCwd(root);
  const out = [];
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const file = path.join(DIR, f);
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const newest = Math.max(0, ...Object.values(rec.repos || {}).map((r) => r.at));
      if (Date.now() - newest > Math.max(FORGET_MS, windowMs)) { fs.unlinkSync(file); continue; }
      const hit = rec.repos && rec.repos[key];
      if (rec.id !== selfId && hit && Date.now() - hit.at < windowMs) out.push({ id: rec.id, ...hit });
    } catch { /* being rewritten */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

module.exports = { touch, end, othersIn };
