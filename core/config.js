'use strict';
// Optional user config at ~/.agent-traffic/config.json, one section per guard:
//   { "heavy": { "capacity": 6 }, "port": { "enabled": false } }
// Missing keys fall back to the defaults below.

const fs = require('fs');
const path = require('path');
const { HOME } = require('./state');

const CONFIG_FILE = path.join(HOME, 'config.json');

const DEFAULTS = {
  heavy: {
    enabled: true,
    capacity: 4,
    // A job may join already-running heavy jobs only if this much RAM is free.
    // Never applied when nothing heavy runs, so a box whose RAM is already eaten
    // by browsers/IDEs still gets one build at a time instead of none.
    minFreeMemMB: 2048,
    maxWaitSec: 300,
    lowPriority: true,
    rules: [],              // extra rules, checked together with the defaults
    disableDefaultRules: false,
    exclude: null,          // extra exclude regex
  },
  port: { enabled: true },
  dedupe: { enabled: true },
  conflict: { enabled: true },
  background: { enabled: true },
  // A session counts as working in a git working tree from its first command or
  // edit there until it ends (SessionEnd hook), or until it has been idle there
  // this many minutes, which covers sessions that crashed without ending.
  git: { enabled: true, activeWindowMin: 240 },
};

function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* optional */ }
  const cfg = {};
  for (const k of Object.keys(DEFAULTS)) cfg[k] = { ...DEFAULTS[k], ...(user[k] || {}) };
  return cfg;
}

module.exports = { CONFIG_FILE, loadConfig };
