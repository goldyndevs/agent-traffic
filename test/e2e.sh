#!/usr/bin/env bash
# End-to-end check with real headless Claude Code sessions running in parallel.
# Usage: bash test/e2e.sh [model]     (default model: sonnet). Takes a few minutes.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${1:-sonnet}"
export AGENT_TRAFFIC_HOME="$(mktemp -d)"
W="$(mktemp -d)"
P=$((47000 + RANDOM % 2000))
LOG="$W/runs.log"; : > "$LOG"
NLOG="$(cd "$W" && (pwd -W 2>/dev/null || pwd))/runs.log" # path node can open (Git Bash /tmp is not)

# session <name> <dir> <seconds> <prompt>: headless Claude with the plugin, transcript in
# $W/<name>.jsonl. A -p session stays alive while it has background tasks (dev
# servers), so each one gets a hard time limit.
session() {
  (cd "$2" && printf '%s' "$4" | timeout "$3" claude -p --plugin-dir "$ROOT" --model "$MODEL" \
     --allowedTools "Bash" "PowerShell" "Edit" "Write" "Read" --verbose --output-format stream-json > "$W/$1.jsonl" 2>/dev/null)
}
# Same, but with no --allowedTools: permissions come only from settings files.
session_settings_only() {
  (cd "$2" && printf '%s' "$4" | timeout "$3" claude -p --plugin-dir "$ROOT" --model "$MODEL" \
     --verbose --output-format stream-json > "$W/$1.jsonl" 2>/dev/null)
}
cleanup() {
  powershell.exe -NoProfile -Command "Get-NetTCPConnection -State Listen -EA 0 | ? { \$_.LocalPort -ge $P -and \$_.LocalPort -le $((P + 20)) } | % { Stop-Process -Id \$_.OwningProcess -Force -EA 0 }; Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ? { \$_.CommandLine -match [regex]::Escape('$ROOT') } | % { Stop-Process -Id \$_.ProcessId -Force -EA 0 }" >/dev/null 2>&1
}
trap cleanup EXIT
# summary <name>: tool calls, denials, final answer
summary() {
  echo "----- session $1"
  node -e '
const lines=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const cut=(s,n)=>String(s).replace(/\s+/g," ").slice(0,n);
for(const m of lines){
  if(m.type==="assistant")for(const c of m.message.content){if(c.type==="tool_use")console.log("  CALL  ",cut(JSON.stringify(c.input),220));}
  if(m.type==="user")for(const c of (m.message.content||[])){if(c.type==="tool_result")console.log("  RESULT",cut(typeof c.content==="string"?c.content:JSON.stringify(c.content),320));}
  if(m.type==="result")console.log("  FINAL ",cut(m.result,600));
}' "$W/$1.jsonl"
}
listening() { node -e "require('net').connect($1,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; }

# Fixtures. srv.js logs every start, so duplicate servers are visible in $LOG.
mkdir -p "$W/app" "$W/other" "$W/tests"
cat > "$W/app/srv.js" <<EOF
const port = +process.argv[process.argv.indexOf('--port') + 1];
require('fs').appendFileSync(String.raw\`$NLOG\`, 'server-start app ' + port + '\n');
require('http').createServer((q, s) => s.end('APP-OK')).listen(port);
EOF
echo "{\"name\":\"app\",\"scripts\":{\"dev\":\"node srv.js --port $P\"}}" > "$W/app/package.json"
cp "$W/app/srv.js" "$W/other/srv.js"; sed -i 's/server-start app/server-start other/' "$W/other/srv.js"
echo "{\"name\":\"other\",\"scripts\":{\"dev\":\"node srv.js --port $P\"}}" > "$W/other/package.json"
cat > "$W/tests/t.js" <<EOF
require('fs').appendFileSync(String.raw\`$NLOG\`, 'tests-start\n');
setTimeout(() => console.log('TESTS-OK'), 20000);
EOF
echo '{"name":"tests","scripts":{"test":"node t.js"}}' > "$W/tests/package.json"

if [ -z "${E2E_ONLY_PERM:-}${E2E_ONLY_NEW:-}" ]; then
echo "== S1/S2 port guard (port $P)"
session A "$W/app" 150 "Start this project's dev server with exactly: npm run dev   Run it in the FOREGROUND (not background) with a 120000 ms timeout; it is expected to keep running until the timeout. Then just report what happened." &
A=$!
for _ in $(seq 120); do listening $P && break; sleep 1; done
listening $P && echo "A's server is up on $P" || echo "A's server never came up"
session B "$W/app" 180 "Start the dev server for this project so I can try the app in my browser, then tell me the URL to open." &
B=$!
session C "$W/other" 180 "Start the dev server for this project so I can try it in my browser, then tell me the URL. Do not stop or kill any process you did not start." &
C=$!
wait $B $C
echo "after B and C: A's server still up? $(listening $P && echo yes || echo NO)"
node "$ROOT/bin/agent-traffic.js" status | sed 's/^/  /'

echo "== S3 dedupe (npm test, 20 s)"
session D "$W/tests" 120 "Run the test suite with exactly: npm test   (foreground, timeout 120000 ms) and report the result." &
D=$!
for _ in $(seq 60); do grep -q tests-start "$LOG" && break; sleep 1; done
session E "$W/tests" 120 "Run the test suite with: npm test   and report the result." &
E=$!
wait $D $E
wait $A
fi

if [ -n "${E2E_ONLY_NEW:-}" ]; then
echo "== S5 git guard: another session has uncommitted work in the same working tree"
mkdir -p "$W/repo" && (cd "$W/repo" && git init -q && git config user.email t@t && git config user.name t \
  && echo base > notes.txt && git add . && git commit -qm init)
# H must still be alive when I acts (its SessionEnd hook forgets it). Claude Code
# blocks a bare `sleep`, so H waits with node instead.
session H "$W/repo" 150 "Use the Edit tool to append the line 'H was here' to notes.txt. Do not commit. Then run exactly this in the foreground with a 120000 ms timeout: node -e \"setTimeout(()=>{},90000)\"   and report." &
H=$!
for _ in $(seq 120); do grep -q "H was here" "$W/repo/notes.txt" 2>/dev/null && break; sleep 1; done
sleep 3
session I "$W/repo" 150 "Switch this repository to a new branch named feature-x (create it). Then tell me which branch is checked out."
echo "  branch after I: $(cd "$W/repo" && git branch --show-current) (expect the original branch, not feature-x)"
echo "  H's edit still uncommitted in notes.txt: $(grep -c 'H was here' "$W/repo/notes.txt")"
wait $H

echo "== S6 background guard: dev server requested in the foreground"
P5=$((P + 15))
mkdir -p "$W/bg"; cp "$W/app/srv.js" "$W/bg/"
echo "{\"scripts\":{\"dev\":\"node srv.js --port $P5\"}}" > "$W/bg/package.json"
session J "$W/bg" 200 "Run exactly: npm run dev   in the foreground (do NOT set run_in_background yourself), then check it responds and tell me the URL."
# The -p process itself lives on while the server runs, so time the first answer instead.
echo "  J answered after $(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").map(x=>{try{return JSON.parse(x)}catch{}}).find(m=>m&&m.type==="result");console.log(l?Math.round(l.duration_ms/1000):"?")' "$W/J.jsonl")s (a foreground dev server would block ~120 s+)"
fi

echo "== S4 auto-approve: user allow rule for npm test, no --allowedTools"
mkdir -p "$W/perm/.claude" "$W/noperm"
cp "$W/tests/t.js" "$W/tests/package.json" "$W/perm/"; cp "$W/tests/t.js" "$W/tests/package.json" "$W/noperm/"
sed -i 's/20000/1000/' "$W/perm/t.js" "$W/noperm/t.js"
echo '{"permissions":{"allow":["Bash(npm test)","PowerShell(npm test)"]}}' > "$W/perm/.claude/settings.local.json"
session_settings_only F "$W/perm" 120 "Run exactly: npm test   and report the output. Do not use any other command." &
session_settings_only G "$W/noperm" 120 "Run exactly: npm test   and report the output. Do not use any other command." &
wait
for s in F G; do echo "  $s: TESTS-OK seen: $(grep -c TESTS-OK "$W/$s.jsonl") | blocked for approval: $(grep -c 'requires approval' "$W/$s.jsonl")"; done
echo "  (expect F: TESTS-OK > 0, blocked 0;  G: TESTS-OK 0, blocked > 0)"

echo "== results"
echo "runs log:"; sed 's/^/  /' "$LOG"
echo "server-start app count:   $(grep -c 'server-start app' "$LOG")  (expect 1)"
echo "server-start other count: $(grep -c 'server-start other' "$LOG")  (expect 0 on port $P)"
echo "tests-start count:        $(grep -c 'tests-start' "$LOG")  (expect 1 while D ran; 2 only if E waited and reran after D finished)"
for s in A B C D E F G H I J; do [ -s "$W/$s.jsonl" ] && summary $s; done
sleep 2; echo "registry left over: $(ls -A "$AGENT_TRAFFIC_HOME"/holders "$AGENT_TRAFFIC_HOME"/queue "$AGENT_TRAFFIC_HOME"/servers 2>/dev/null | grep -v ':$' | grep -c .)"
echo "transcripts kept in $W"
