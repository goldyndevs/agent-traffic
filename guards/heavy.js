'use strict';
// Heavy guard: a machine-wide queue for heavy builds so parallel agents never run
// two of them at once. The command gets a gate line in front of it
// (`agent-traffic acquire --owner <shell pid>`) that waits for capacity, then the
// original command runs unchanged in the agent's own shell.

const fs = require('fs');
const state = require('../core/state');
const { CMD, END, executedPart } = require('../core/command');

// Capacity is in abstract units, not cores. Defaults: mobile builds weigh 3,
// web/backend builds and parallel test runners 2, installs/type checks 1, on a
// capacity of 4. So two mobile builds (or a mobile + web build) never overlap,
// while two web builds may (if RAM allows, see minFreeMemMB).
// Long-running processes (emulators, `docker compose up`, dev servers) are
// deliberately not queued: they never finish, so holding a slot would deadlock
// the builds that need them. Their RAM use is covered by the minFreeMemMB check.
const DEFAULT_RULES = [
  { label: 'gradle', weight: 3, pattern: `${CMD}gradlew?(\\.bat)?${END}` },
  { label: 'flutter', weight: 3, pattern: '\\bflutter\\s+build\\b' },
  { label: 'react-native', weight: 3, pattern: '\\breact-native\\s+run-(android|ios)\\b' },
  { label: 'expo', weight: 3, pattern: '\\bexpo\\s+run:(android|ios)\\b|\\beas\\s+build\\b.*--local' },
  { label: 'xcode', weight: 3, pattern: '\\bxcodebuild\\b' },
  { label: 'docker', weight: 2, pattern: '\\bdocker(\\s+compose|-compose)?\\s+(build|buildx\\s+build)\\b' },
  { label: 'web-build', weight: 2, pattern: '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?build\\b' },
  { label: 'web-build', weight: 2, pattern: '\\b(next|vite|nuxt|nuxi|astro|ng|webpack|turbo|nx|remix|svelte-kit)\\s+(run\\s+)?build\\b' },
  { label: 'dotnet', weight: 2, pattern: '\\bdotnet\\s+(build|publish|test)\\b' },
  { label: 'maven', weight: 2, pattern: '\\bmvnw?\\s+.*\\b(package|install|verify)\\b' },
  { label: 'cargo', weight: 2, pattern: '\\bcargo\\s+(build|test)\\b' },
  { label: 'swift', weight: 2, pattern: '\\bswift\\s+build\\b' },
  { label: 'native', weight: 2, pattern: `\\bcmake\\s+--build\\b|\\bmake\\b[^;&|\\n]*\\s-j|${CMD}ninja${END}` },
  { label: 'go', weight: 2, pattern: '\\bgo\\s+(build|test)\\b' },
  // Test runners that fan out over all cores.
  { label: 'tests', weight: 2, pattern: `${CMD}(jest|vitest)${END}|\\bcypress\\s+run\\b|\\bplaywright\\s+test\\b` },
  { label: 'tests', weight: 2, pattern: '\\b(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b' },
  { label: 'tests', weight: 2, pattern: `${CMD}pytest(?=\\s)[^;&|\\n]*\\s-n\\s` },
  { label: 'media', weight: 2, pattern: `${CMD}ffmpeg${END}` },
  { label: 'pods', weight: 2, pattern: '\\bpod\\s+install\\b' },
  // Lighter but still disk/CPU heavy.
  { label: 'install', weight: 1, pattern: '\\bnpm\\s+(install|i|ci|uninstall|un|rm|remove|update|up)\\b|\\bpnpm\\s+(install|i|add|remove|rm|update|up)\\b|\\byarn\\s+(install|add|remove|upgrade)\\b|\\bbun\\s+(install|i|add|remove|rm|update)\\b' },
  { label: 'install', weight: 1, pattern: '\\bdotnet\\s+(restore|add\\s+package|remove\\s+package)\\b' },
  { label: 'typecheck', weight: 1, pattern: '\\btsc\\s+(-b|--build|--noEmit|-p)\\b' },
];

// Commands that look heavy but are not (watchers, dev servers, daemon control).
const DEFAULT_EXCLUDE = '--watch\\b|:watch\\b|\\bgradlew?(\\.bat)?\\s+--(stop|status|version)\\b';

// Returns { label, weight } of the heaviest matching rule, or null.
function classify(command, hcfg) {
  const cmd = executedPart(command);
  if (new RegExp(DEFAULT_EXCLUDE).test(cmd)) return null;
  if (hcfg.exclude && new RegExp(hcfg.exclude).test(cmd)) return null;
  const rules = [...(hcfg.rules || []), ...(hcfg.disableDefaultRules ? [] : DEFAULT_RULES)];
  let best = null;
  for (const r of rules) {
    if (new RegExp(r.pattern).test(cmd) && (!best || r.weight > best.weight)) {
      best = { label: r.label, weight: r.weight };
    }
  }
  return best;
}

// Why a job of this weight can't start next to `holders`, or null if it can.
function blocker(holders, weight, hcfg) {
  const used = holders.reduce((sum, h) => sum + h.weight, 0);
  if (used + weight > hcfg.capacity) return 'capacity';
  if (holders.length && state.freeMemMB() < hcfg.minFreeMemMB) return 'ram';
  return null;
}

// True if a job of this weight would have to wait right now.
function isBusy(weight, hcfg) {
  const s = state.snapshot();
  return s.queue.length > 0 || blocker(s.holders, Math.min(weight, hcfg.capacity), hcfg) !== null;
}

// Blocks until `owner` (default: this process) holds `weight` units, or maxWaitMs
// passes. The slot is held until the owner pid exits or release(owner) is called.
// Returns { ok: true } or { ok: false, why, holders, queue }.
function acquire(job, hcfg, maxWaitMs, onWait, owner = process.pid) {
  const { HOLDERS, QUEUE, withLock, readLive, recFile } = state;
  const weight = Math.min(Math.max(1, job.weight | 0), hcfg.capacity);
  const me = { ...job, weight, pid: process.pid, since: Date.now() };
  withLock(() => fs.writeFileSync(recFile(QUEUE, me.pid), JSON.stringify(me)));
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const r = withLock(() => {
      const holders = readLive(HOLDERS);
      const queue = readLive(QUEUE);
      if (holders.some((h) => h.pid === owner)) { // owner already holds a slot: don't wait on itself
        fs.unlinkSync(recFile(QUEUE, me.pid));
        return { ok: true };
      }
      const head = queue[0] && queue[0].pid === me.pid;
      const why = head ? blocker(holders, weight, hcfg) : 'queue';
      if (!why) {
        fs.writeFileSync(recFile(HOLDERS, owner), JSON.stringify({ ...me, pid: owner, since: Date.now() }));
        fs.unlinkSync(recFile(QUEUE, me.pid));
        return { ok: true };
      }
      return { ok: false, why, holders, queue };
    });
    if (r.ok) return r;
    if (Date.now() >= deadline) {
      withLock(() => { try { fs.unlinkSync(recFile(QUEUE, me.pid)); } catch { /* ignore */ } });
      return r;
    }
    if (onWait) onWait(r);
    state.sleepSync(1000);
  }
}

// Hook side. Returns null, or a gate plus tool-input changes.
function check(ctx) {
  const hcfg = ctx.cfg.heavy;
  const hit = ctx.heavy; // classified once by the hook
  if (!hcfg.enabled || !hit) return null;

  // Machine busy now: queue it in the background so the agent keeps working and
  // gets notified when the build finishes. Background jobs wait without limit.
  // ctx.background: the background guard already moved it there.
  const already = ctx.input.run_in_background || ctx.background;
  const forcedBg = !already && isBusy(hit.weight, hcfg);
  const background = already || forcedBg;

  return {
    gate: { sub: 'acquire', required: true, args: `--label ${hit.label} --weight ${hit.weight}${background ? ' --max-wait 0' : ''}` },
    edit(input) {
      if (forcedBg) {
        input.run_in_background = true;
        delete input.timeout; // the agent's foreground timeout must not cut the queue wait
      } else if (!background) {
        // Queue wait + build rarely fit the 2 min default; ask for the tool maximum.
        input.timeout = Math.max(input.timeout || 0, 600000);
      }
    },
    context: forcedBg
      ? `agent-traffic: the machine is busy with other heavy builds, so this ${hit.label} command was queued as a BACKGROUND task. It starts automatically when a slot frees up and you will be notified with its output when it finishes. Do not re-run it; continue with other work, or wait for the notification if you need the result.`
      : `agent-traffic: this ${hit.label} command was routed through a machine-wide build queue (it may wait for other agents' builds). Exit code 75 with "agent-traffic: BUSY" means it did not run; do other work and retry later instead of looping.`,
  };
}

module.exports = { classify, blocker, isBusy, acquire, check };
