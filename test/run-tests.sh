#!/usr/bin/env bash
# agent-traffic test suite (Git Bash on Windows, also Linux/macOS where noted).
# Usage: bash test/run-tests.sh      Uses an isolated AGENT_TRAFFIC_HOME.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export AGENT_TRAFFIC_HOME="$(mktemp -d)"
export CLAUDE_PLUGIN_ROOT="$ROOT"
H="$ROOT/bin/agent-traffic.js"
WORK="$(mktemp -d)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }
now()  { node -e 'console.log(Date.now())'; }
reset_state() { rm -rf "$AGENT_TRAFFIC_HOME"/*; }
on_windows() { [ -e /proc/$$/winpid ]; }
MYPID="$(cat /proc/$$/winpid 2>/dev/null || echo $$)"

# hook_out <tool> <command> [bg] [cwd]  -> prints full hook JSON output
hook_out() {
  node -e 'const [t,c,bg,cwd]=process.argv.slice(1);process.stdout.write(JSON.stringify({tool_name:t,cwd:cwd||undefined,tool_input:{command:c,run_in_background:bg==="1"}}))' "$1" "$2" "${3:-0}" "${4:-}" \
    | node "$ROOT/hooks/pretooluse.js"
}
# gated <command> -> rewritten bash command (or original if hook passed it through)
gated() {
  local out; out="$(hook_out Bash "$1")"
  if [ -z "$out" ]; then printf '%s' "$1"; else
    printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hookSpecificOutput.updatedInput.command))'
  fi
}
field() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!s){console.log("NONE");return}const o=JSON.parse(s).hookSpecificOutput;console.log(String(eval(process.argv[1])))})' "$2"; }
# occupy <weight> <seconds>: hold a slot in the background, returns once it is held
occupy() { node "$H" run --weight "$1" --label occupy -- "sleep $2" >/dev/null 2>&1 &
  for _ in $(seq 50); do [ -n "$(ls "$AGENT_TRAFFIC_HOME/holders" 2>/dev/null)" ] && break; sleep 0.1; done; }

echo "T1 classification"
cd "$ROOT"
node -e '
const l=require("./guards/heavy");const c=require("./core/config").loadConfig().heavy;let bad=0;
const heavy=["./gradlew assembleDebug","cd android && ./gradlew :app:bundleRelease","gradlew.bat build","flutter build apk --release","npm run build","pnpm build","yarn build","npx next build","ng build","dotnet publish -c Release","docker compose build","xcodebuild -scheme App","npx expo run:android","bash -lc x; ./gradlew build | tail -20",
 "npx jest","npx vitest run","./node_modules/.bin/jest --ci","npm test","pnpm run test","npx playwright test","npx cypress run","pytest -n 8 tests/","go test ./...","go build ./cmd/x","cmake --build build -j 8","make -j8","ninja -C out","swift build","ffmpeg -i a.mp4 b.webm","cd ios && pod install","npm install","npm ci","pnpm i","yarn install","tsc --noEmit","npx tsc -b"];
const light=[`grep -rn "npm run build" .`,`git commit -m "fix: ./gradlew assembleDebug crash"`,"cat > N.md <<'"'"'EOF'"'"'\nrun npm run build\nflutter build apk\nEOF\necho done",`git commit -m "$(cat <<'"'"'EOF'"'"'\nci: gradlew build\nEOF\n)"`,`echo '"'"'flutter build'"'"'`,"npm run dev","npm run build:watch","./gradlew --stop","cat build.gradle","ls gradle/","# npm run build\nls","vite",
 "cat jest.config.js","code vitest.config.ts","cat build.ninja","npx jest --watch","pytest tests/test_a.py","make clean","emulator -avd Pixel_7","docker compose up -d","npm run start","tsc --version","git log --grep jest","ls ffmpeg-bin/","git add gradlew","rg ffmpeg src/"];
for(const s of heavy) if(!l.classify(s,c)){bad++;console.log("  FAIL heavy not detected:",JSON.stringify(s))}
for(const s of light) if(l.classify(s,c)){bad++;console.log("  FAIL light flagged:",JSON.stringify(s),JSON.stringify(l.classify(s,c)))}
console.log(bad?"":"  PASS all "+(heavy.length+light.length)+" samples");process.exit(bad?1:0)' && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "T2 hook rewrite rules"
reset_state
check "light command untouched" '[ -z "$(hook_out Bash "git status")" ]'
check "non-shell tool untouched" '[ -z "$(node -e "process.stdout.write(JSON.stringify({tool_name:\"Read\",tool_input:{file_path:\"x\"}}))" | node "$ROOT/hooks/pretooluse.js")" ]'
G="$(gated "npm run build")"
check "already-gated not double-gated" '[ -z "$(hook_out Bash "$G")" ]'
check "original kept verbatim before the tail line" '[ "$(printf "%s" "$G" | tail -n2 | head -n1)" = "npm run build" ]'
check "gated command survives bash tail-exec (owner stays alive)" '[ -n "$(bash -c "$(gated "npm run build >/dev/null 2>&1; sleep 2")" >/dev/null 2>&1 & sleep 1.2; ls -A "$AGENT_TRAFFIC_HOME/holders"; wait)" ]'
check "foreground gets 600000 timeout" '[ "$(field "$(hook_out Bash "npm run build")" "o.updatedInput.timeout")" = "600000" ]'
check "idle: not forced to background" '[ "$(field "$(hook_out Bash "npm run build")" "o.updatedInput.run_in_background")" = "false" ]'
V="$(field "$(hook_out Bash "npm run build" 1)" 'o.updatedInput.run_in_background+"|"+o.updatedInput.command.includes("--max-wait 0")')"
check "agent background kept, waits forever (got $V)" '[ "$V" = "true|true" ]'
occupy 4 6
V="$(field "$(hook_out Bash "npm run build")" 'o.updatedInput.run_in_background+"|"+o.updatedInput.timeout+"|"+o.updatedInput.command.includes("--max-wait 0")')"
check "busy: forced to background, no timeout, waits forever (got $V)" '[ "$V" = "true|undefined|true" ]'
PSG="$(field "$(hook_out PowerShell "dotnet build")" "o.updatedInput.command")"
if [[ "$PSG" == *'--owner $PID; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'* ]]; then ok "PowerShell gate uses PID + LASTEXITCODE"; else bad "PowerShell gate: $PSG"; fi
wait

echo "T3 gated command keeps the agent shell context"
reset_state
mkdir -p "$WORK/proj/sub" && cd "$WORK/proj"
shopt -s expand_aliases; alias hgalias='echo ALIAS-OK'; hgfunc() { echo FUNC-OK; }
GC="$(gated 'npm run build >/dev/null 2>&1; hgalias; hgfunc; cd sub')"
eval "$GC" > "$WORK/t3.out"; OUT="$(cat "$WORK/t3.out")"  # no $(...): cd must hit this shell
check "alias works inside gated command" '[[ "$OUT" == *ALIAS-OK* ]]'
check "shell function works" '[[ "$OUT" == *FUNC-OK* ]]'
check "cd persists after gated command" '[ "$(basename "$PWD")" = "sub" ]'
cd "$WORK"
( eval "$(gated 'npm run build >/dev/null 2>&1; exit 7')" ); RC=$?
reset_state  # the evals above made this test shell the slot owner
check "exit code of original preserved (7)" '[ $RC -eq 7 ]'
MULTI="$(gated "$(printf 'npm run build >/dev/null 2>&1\necho line2\necho "q:\x27x\x27 \\"y\\""')")"
check "multi-line + quotes preserved" '[ "$(bash -c "$MULTI" | tail -n2 | tr "\n" "|")" = "line2|q:'"'"'x'"'"' \"y\"|" ]'
LONG="npm run build >/dev/null 2>&1; echo LONG-OK # $(head -c 30000 /dev/zero | tr '\0' x)"
check "30k-char command runs" '[ "$(bash -c "$(gated "$LONG")")" = "LONG-OK" ]'
check "no slot left behind after commands" 'sleep 1.5; [ -z "$(ls "$AGENT_TRAFFIC_HOME/holders")" ]'

echo "T4 mutual exclusion + FIFO (2 mobile builds)"
reset_state; LOG="$WORK/t4.log"; : > "$LOG"
J='echo "$X start $(node -e "console.log(Date.now())")" >> '"$LOG"'; sleep 3; echo "$X end $(node -e "console.log(Date.now())")" >> '"$LOG"'; flutter build x >/dev/null 2>&1; true'
GJ="$(gated "$J")"
X=A bash -c "$GJ" & sleep 0.7; X=B bash -c "$GJ" & wait
AE=$(awk '/A end/{print $3}' "$LOG"); BS=$(awk '/B start/{print $3}' "$LOG")
check "B starts only after A ends" '[ -n "$AE" ] && [ -n "$BS" ] && [ "$BS" -ge "$AE" ]'

echo "T5 BUSY timeout: exit 75 and original NOT run"
reset_state; occupy 4 6
rm -f "$WORK/ran"
G="$(gated "npm run build; touch $WORK/ran")"; G="${G/--max-wait 0/--max-wait 2}"
G="$(printf '%s' "$G" | sed '1s/--desc/--max-wait 2 --desc/')"
bash -c "$G" >/dev/null 2>&1; RC=$?
check "exit code 75" '[ $RC -eq 75 ]'
check "original did not run" '[ ! -e "$WORK/ran" ]'
check "BUSY waiter removed from queue" '[ -z "$(ls "$AGENT_TRAFFIC_HOME/queue")" ]'
wait

echo "T6 hard-killed shell frees its slot"
reset_state
bash -c "$(gated 'npm run build >/dev/null 2>&1; sleep 30')" & SH=$!
for _ in $(seq 50); do [ -n "$(ls "$AGENT_TRAFFIC_HOME/holders")" ] && break; sleep 0.1; done
if on_windows; then taskkill //PID "$(cat /proc/$SH/winpid)" //T //F >/dev/null 2>&1; else kill -9 $SH; fi
sleep 1.5
check "slot freed within 1.5s by watcher" '[ -z "$(ls "$AGENT_TRAFFIC_HOME/holders")" ]'
T0=$(now); node "$H" acquire --owner $MYPID --weight 4 --max-wait 3 >/dev/null 2>&1; RC=$?
check "next job acquires immediately" '[ $RC -eq 0 ] && [ $(( $(now) - T0 )) -lt 2500 ]'
reset_state

echo "T7 killed waiter leaves queue, next in line proceeds"
reset_state; occupy 4 4
bash -c "$(gated 'npm run build >/dev/null 2>&1')" >/dev/null 2>&1 & W1=$!
sleep 0.8
rm -f "$WORK/t7"; bash -c "$(gated "npm run build >/dev/null 2>&1; touch $WORK/t7")" >/dev/null 2>&1 & W2=$!
sleep 0.8
if on_windows; then taskkill //PID "$(cat /proc/$W1/winpid)" //T //F >/dev/null 2>&1; else kill -9 $W1; fi
wait $W2
check "second waiter ran after first waiter was killed" '[ -e "$WORK/t7" ]'
wait

echo "T8 stress: 8 jobs weight 2, capacity 4 -> never more than 2 at once"
reset_state; LOG="$WORK/t8.log"; : > "$LOG"
J='echo "+ $(node -e "console.log(Date.now())")" >> '"$LOG"'; sleep 1; echo "- $(node -e "console.log(Date.now())")" >> '"$LOG"'; npm run build >/dev/null 2>&1; true'
GJ="$(gated "$J")"
for i in $(seq 8); do bash -c "$GJ" >/dev/null 2>&1 & done; wait
MAX=$(sort -k2 -n "$LOG" | awk '{c+=($1=="+")?1:-1; if(c>m)m=c} END{print m}')
check "all 8 ran" '[ "$(grep -c "^+" "$LOG")" -eq 8 ]'
check "max concurrency <= 2 (got $MAX)" '[ "$MAX" -le 2 ]'
check "state clean after stress" 'sleep 1.5; [ -z "$(ls -A "$AGENT_TRAFFIC_HOME/holders")$(ls -A "$AGENT_TRAFFIC_HOME/queue")" ]'

echo "T9 build runs at below-normal priority"
reset_state
if on_windows; then
  P="$(bash -c "$(gated 'npm run build >/dev/null 2>&1; powershell.exe -NoProfile -Command "(Get-Process -Id \$PID).PriorityClass"')" | tr -d '\r')"
  check "child priority BelowNormal (got $P)" '[ "$P" = "BelowNormal" ]'
else
  P="$(bash -c "$(gated 'npm run build >/dev/null 2>&1; ps -o nice= -p $$')" | tr -d ' ')"
  check "child nice > 0 (got $P)" '[ "$P" -gt 0 ]'
fi

echo "T10 same shell gated twice does not deadlock"
reset_state
G1="$(gated 'flutter build x >/dev/null 2>&1; true')"
TO="$(command -v timeout >/dev/null && echo 'timeout 30')"  # macOS has no `timeout`
OUT="$($TO bash -c "$G1"$'\n'"$(printf '%s' "$G1" | head -n1)"$'\necho REENTRANT-OK')"
check "second acquire by same owner returns" '[[ "$OUT" == *REENTRANT-OK* ]]'

echo "T11 corrupted state + stale lock are recovered"
reset_state; node "$H" status >/dev/null
echo "{garbage" > "$AGENT_TRAFFIC_HOME/holders/12345.json"
echo '{"pid":999999,"weight":4,"since":0}' > "$AGENT_TRAFFIC_HOME/holders/999999.json"
echo 999999 > "$AGENT_TRAFFIC_HOME/lock"
T0=$(now); node "$H" acquire --owner $MYPID --weight 4 --max-wait 3 >/dev/null 2>&1; RC=$?
check "acquire succeeds despite junk + dead-owner lock" '[ $RC -eq 0 ] && [ $(( $(now) - T0 )) -lt 2000 ]'
reset_state

echo "T13 RAM gate: joins a running job only with enough free RAM, never blocks a lone job"
reset_state; mkdir -p "$AGENT_TRAFFIC_HOME"
echo '{"heavy":{"minFreeMemMB": 99999999}}' > "$AGENT_TRAFFIC_HOME/config.json"
T0=$(now); node "$H" acquire --owner $MYPID --weight 1 --max-wait 3 >/dev/null 2>&1; RC=$?
check "lone job runs even with 'too little' RAM" '[ $RC -eq 0 ] && [ $(( $(now) - T0 )) -lt 2000 ]'
rm -f "$AGENT_TRAFFIC_HOME/holders/$MYPID.json"
occupy 1 6
OUT="$(node "$H" acquire --owner $MYPID --weight 1 --max-wait 2 2>&1)"; RC=$?
check "second job waits for RAM although capacity is free (rc $RC)" '[ $RC -eq 75 ]'
check "wait reason says RAM" '[[ "$OUT" == *"free RAM too low"* ]]'
V="$(field "$(hook_out Bash "npm run build")" 'o.updatedInput.run_in_background')"
check "hook treats RAM-blocked machine as busy (bg=$V)" '[ "$V" = "true" ]'
echo '{"heavy":{"minFreeMemMB": 0}}' > "$AGENT_TRAFFIC_HOME/config.json"
node "$H" acquire --owner $MYPID --weight 1 --max-wait 2 >/dev/null 2>&1; RC=$?
check "with RAM threshold 0 the second job joins" '[ $RC -eq 0 ]'
wait; reset_state

winpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
decision() { field "$1" 'o.permissionDecision'; }
reason() { field "$1" 'o.permissionDecisionReason'; }
killshell() { if on_windows; then taskkill //PID "$(cat /proc/$1/winpid)" //T //F >/dev/null 2>&1; else kill -9 $1; fi; }
killport() { if on_windows; then powershell.exe -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort $1 -EA 0 | % { Stop-Process -Id \$_.OwningProcess -Force -EA 0 }" >/dev/null 2>&1; else lsof -ti tcp:$1 -sTCP:LISTEN | xargs -r kill -9; fi; }
emptied() { for _ in $(seq 40); do [ -z "$(ls -A "$1")" ] && return 0; sleep 0.2; done; return 1; }
portfree() { for _ in $(seq 40); do waitport_once $1 || return 0; sleep 0.2; done; return 1; }
waitport_once() { node -e "require('net').connect($1,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; }
waitport() { for _ in $(seq 60); do node -e "require('net').connect($1,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" && return 0; sleep 0.2; done; return 1; }

echo "T14 dedupe: identical command already running in the same dir is denied"
reset_state; mkdir -p "$WORK/dd" "$WORK/dd2"; cd "$WORK/dd"
DD='npm install >/dev/null 2>&1; sleep 5'
bash -c "$(gated "$DD")" >/dev/null 2>&1 & DDPID=$!
for _ in $(seq 50); do [ -n "$(ls -A "$AGENT_TRAFFIC_HOME/holders" 2>/dev/null)" ] && break; sleep 0.1; done
O="$(hook_out Bash "$DD" 0 "$(winpath "$WORK/dd")")"
check "same command, same dir -> deny" '[ "$(decision "$O")" = "deny" ]'
check "reason explains it is already running" '[[ "$(reason "$O")" == *"already running"* ]]'
check "same command, other dir -> allowed" '[ "$(decision "$(hook_out Bash "$DD" 0 "$(winpath "$WORK/dd2")")")" != "deny" ]'
check "bypass marker -> allowed" '[ "$(decision "$(hook_out Bash "AGENT_TRAFFIC_ALLOW=1 $DD" 0 "$(winpath "$WORK/dd")")")" != "deny" ]'
check "light command never denied" '[ -z "$(hook_out Bash "git status" 0 "$(winpath "$WORK/dd")")" ]'
wait $DDPID
check "after it finished -> allowed again" 'sleep 1; [ "$(decision "$(hook_out Bash "$DD" 0 "$(winpath "$WORK/dd")")")" != "deny" ]'
cd "$WORK"

echo "T15 port guard"
reset_state
P1=$((40000 + RANDOM % 5000)); P2=$((P1 + 7)); P3=$((P1 + 13))
node -e "require('http').createServer((q,s)=>s.end('x')).listen($P1,'127.0.0.1')" & FOREIGN=$!
waitport $P1
O="$(hook_out Bash "npx vite --port $P1")"
check "explicit busy port -> deny" '[ "$(decision "$O")" = "deny" ]'
check "names the process holding it" '[[ "$(reason "$O")" == *"node"* ]]'
check "suggests a free port" '[[ "$(reason "$O")" == *"free port instead, e.g."* ]]'
O="$(hook_out Bash "npx vite --port $P2")"
check "free port -> allowed + registered" '[ "$(decision "$O")" != "deny" ] && [[ "$(field "$O" o.updatedInput.command)" == *"register --label vite --port $P2"* ]]'
check "bypass marker -> allowed" '[ "$(decision "$(hook_out Bash "AGENT_TRAFFIC_ALLOW=1 npx vite --port $P1")")" != "deny" ]'
check "vite build is not a server" '[[ "$(field "$(hook_out Bash "npx vite build")" o.updatedInput.command)" != *register* ]]'
check "unknown-port server (dotnet run) registered, not denied" '[[ "$(field "$(hook_out Bash "dotnet run")" o.updatedInput.command)" == *"register --label dotnet --key"* ]]'
mkdir -p "$WORK/pj/web" "$WORK/pv"
echo "{\"scripts\":{\"dev\":\"vite --port $P1\"}}" > "$WORK/pj/web/package.json"
check "port read from package.json script -> deny" '[ "$(decision "$(hook_out Bash "npm run dev" 0 "$(winpath "$WORK/pj/web")")")" = "deny" ]'
check "follows leading cd into the project" '[ "$(decision "$(hook_out Bash "cd web && npm run dev" 0 "$(winpath "$WORK/pj")")")" = "deny" ]'
echo "export default { server: { port: $P1 } }" > "$WORK/pv/vite.config.ts"
check "port read from vite.config -> deny" '[ "$(decision "$(hook_out Bash "npx vite" 0 "$(winpath "$WORK/pv")")")" = "deny" ]'
check "port-in-text is not a server" '[ -z "$(hook_out Bash "grep -rn \"vite --port $P1\" .")" ]'
killshell $FOREIGN

echo "T16 dev server started by an agent: attribution + release"
reset_state
mkdir -p "$WORK/app" "$WORK/other"
echo "require('http').createServer((q,s)=>s.end('ok')).listen(+process.argv[process.argv.indexOf('--port')+1])" > "$WORK/app/srv.js"
echo "{\"scripts\":{\"dev\":\"node srv.js --port $P3\"}}" > "$WORK/app/package.json"
echo "{\"scripts\":{\"dev\":\"vite --port $P3\"}}" > "$WORK/other/package.json"
cd "$WORK/app"; bash -c "$(gated 'npm run dev')" >/dev/null 2>&1 & SRV=$!; cd "$WORK"
waitport $P3
O="$(hook_out Bash "npm run dev" 0 "$(winpath "$WORK/app")")"
check "same project server running -> deny" '[ "$(decision "$O")" = "deny" ]'
check "tells agent to reuse THIS project server" '[[ "$(reason "$O")" == *"THIS project"*"Reuse it at http://localhost:$P3"* ]]'
O="$(hook_out Bash "npm run dev" 0 "$(winpath "$WORK/other")")"
check "other project on that port -> told it is ANOTHER project" '[[ "$(reason "$O")" == *"ANOTHER project"* ]]'
check "status lists the dev server" '[[ "$(node "$H" status)" == *"Dev servers:"*":$P3"* ]]'
# On Git Bash, npm/node started by the shell are not its Windows children, so
# `taskkill /T` on the shell leaves the server running: stop it by port as well.
killshell $SRV; killport $P3
# release can take a few ticks: the watcher first checks whether the server outlived its shell
check "server record released after its shell dies" 'emptied "$AGENT_TRAFFIC_HOME/servers"'

if on_windows; then
echo "T17 orphaned dev server (shell killed, server survives) keeps its attribution"
portfree $P3
reset_state
cd "$WORK/app"; bash -c "$(gated 'npm run dev')" >/dev/null 2>&1 & SRV=$!; cd "$WORK"
waitport $P3
taskkill //PID "$(cat /proc/$SRV/winpid)" //F >/dev/null 2>&1   # shell only, not the tree
for _ in $(seq 40); do grep -qs orphanOf "$AGENT_TRAFFIC_HOME"/servers/*.json && break; sleep 0.2; done
REC="$(cat "$AGENT_TRAFFIC_HOME"/servers/*.json 2>/dev/null)"
check "record adopted by the listening process" '[[ "$REC" == *orphanOf* ]]'
O="$(hook_out Bash "npm run dev" 0 "$(winpath "$WORK/app")")"
check "still told it is THIS project server" '[[ "$(reason "$O")" == *"THIS project"* ]]'
killport $P3
check "record released once the server itself stops" 'emptied "$AGENT_TRAFFIC_HOME/servers"'
fi

if on_windows; then
echo "T12 PowerShell gate"
reset_state
PSCMD="$(field "$(hook_out PowerShell 'dotnet build-not-real 2>$null; Write-Output PS-OK; exit 7')" "o.updatedInput.command")"
printf '%s' "$PSCMD" > "$WORK/t12.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$WORK/t12.ps1")" > "$WORK/t12.out"; RC=$?
OUT="$(tr -d '\r' < "$WORK/t12.out")"
check "PowerShell original ran" '[[ "$OUT" == *PS-OK* ]]'
check "PowerShell exit code preserved (7, got $RC)" '[ $RC -eq 7 ]'
occupy 4 6
printf '%s' "$(printf '%s' "$PSCMD" | sed '1s/--desc/--max-wait 2 --desc/')" > "$WORK/t12b.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$WORK/t12b.ps1")" >/dev/null 2>&1; RC=$?
check "PowerShell BUSY -> 75 (got $RC)" '[ $RC -eq 75 ]'
wait
fi

echo
echo "T18 auto-approve only when the user's own allow rule covers the original command"
reset_state
CH="$WORK/claudehome"; PR="$WORK/proj18"; mkdir -p "$CH" "$PR/.claude" "$PR/web"
echo '{"permissions":{"allow":["Bash(npm run build)","Bash(npm test:*)","Bash(dotnet *)","Bash(y*n build)","Bash(cargo b:*)","PowerShell(NPM Run Build)"]}}' > "$CH/settings.json"
echo '{"permissions":{"allow":["Bash(pnpm build)"]}}' > "$PR/.claude/settings.local.json"
PRW="$(winpath "$PR")"
# hook18 <tool> <command> [mode] -> permissionDecision ("undefined" if none)
hook18() {
  node -e 'const [t,c,m,cwd]=process.argv.slice(1);process.stdout.write(JSON.stringify({tool_name:t,cwd,permission_mode:m,tool_input:{command:c}}))' "$1" "$2" "${3:-default}" "$PRW" \
    | CLAUDE_CONFIG_DIR="$(winpath "$CH")" CLAUDE_PROJECT_DIR="$PRW" node "$ROOT/hooks/pretooluse.js" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s?JSON.parse(s).hookSpecificOutput.permissionDecision:"nohook"))'
}
check "exact rule -> allow"                          '[ "$(hook18 Bash "npm run build")" = allow ]'
check "prefix :* rule -> allow"                      '[ "$(hook18 Bash "npm test -- --ci")" = allow ]'
check "prefix space-* rule -> allow"                 '[ "$(hook18 Bash "dotnet build -c Release")" = allow ]'
check "project settings.local rule -> allow"         '[ "$(hook18 Bash "pnpm build")" = allow ]'
check "cd inside project + allowed -> allow"         '[ "$(hook18 Bash "cd web && npm run build")" = allow ]'
check "cd outside project -> prompt"                 '[ "$(hook18 Bash "cd .. && npm run build")" = undefined ]'
check "compound && other command -> prompt"          '[ "$(hook18 Bash "npm run build && rm -rf x")" = undefined ]'
check "newline-separated extra command -> prompt"    '[ "$(hook18 Bash "npm run build
rm -rf x")" = undefined ]'
check "semicolon -> prompt"                          '[ "$(hook18 Bash "npm run build; echo hi")" = undefined ]'
check "redirect -> prompt"                           '[ "$(hook18 Bash "npm run build > out.txt")" = undefined ]'
check "command substitution -> prompt"               '[ "$(hook18 Bash "npm run build \$(whoami)")" = undefined ]'
check "prefix must end at a word (cargo b:* vs cargo build) -> prompt" '[ "$(hook18 Bash "cargo build")" = undefined ]'
check "mid-wildcard rule never matches -> prompt"    '[ "$(hook18 Bash "yarn build")" = undefined ]'
check "not covered by any rule -> prompt"            '[ "$(hook18 Bash "go build ./...")" = undefined ]'
check "plan mode -> prompt"                          '[ "$(hook18 Bash "npm run build" plan)" = undefined ]'
check "PowerShell rule, case-insensitive -> allow"   '[ "$(hook18 PowerShell "npm run build")" = allow ]'
check "Bash rule does not cover PowerShell"          '[ "$(hook18 PowerShell "npm test")" = undefined ]'
check "light command: hook stays silent"             '[ "$(hook18 Bash "git status")" = nohook ]'
echo '{"permissions":{"allow":["Bash"]}}' > "$CH/settings.json"
check "bare Bash rule -> allow simple command"       '[ "$(hook18 Bash "yarn build")" = allow ]'
check "bare Bash rule still refuses compound"        '[ "$(hook18 Bash "yarn build && curl x")" = undefined ]'

echo "T19 background guard: never-ending commands go to the background"
reset_state
bg() { field "$(hook_out Bash "$1")" 'o.updatedInput.run_in_background'; }
for c in "npx vite --port $((P1 + 17))" "npm run dev" "npx next dev -p $((P1 + 19))" "npm run test:watch" "npx jest --watch" "tsc -w" "nodemon server.js" "tail -f app.log" "docker compose up" "flutter run -d chrome" "emulator -avd Pixel_7" "adb logcat"; do
  check "backgrounded: $c" '[ "$(bg "$c")" = true ]'
done
for c in "curl -w x http://a" "grep -w foo f" "docker compose up -d" "emulator -list-avds" "adb logcat -d" "npm start" "dotnet run" "git status"; do
  check "left in foreground: $c" '[ "$(bg "$c")" != true ]'
done
V="$(field "$(hook_out Bash "npx vite --port $((P1 + 17))" 1)" 'o.additionalContext||"none"')"
check "already background: no note added" '[[ "$V" != *"never finishes"* ]]'
V="$(field "$(hook_out Bash "npm run build && npx vite --port $((P1 + 17))")" 'o.updatedInput.run_in_background+"|"+o.updatedInput.command.includes("--max-wait 0")+"|"+o.updatedInput.timeout')"
check "heavy + server: background, queue waits forever, no timeout (got $V)" '[ "$V" = "true|true|undefined" ]'

echo "T20 conflict guard: clashing commands in the same project"
reset_state
mkdir -p "$WORK/cf/web" "$WORK/cf/api" "$WORK/cf/other"
echo '{"scripts":{"build":"next build","dev":"next dev -p 45999"}}' > "$WORK/cf/web/package.json"
# start <dir> <command>: run it gated in the background, return once registered
start() { (cd "$1" && bash -c "$(gated "$2")" >/dev/null 2>&1) & sleep 0; for _ in $(seq 50); do [ -n "$(ls -A "$AGENT_TRAFFIC_HOME/holders" "$AGENT_TRAFFIC_HOME/servers" 2>/dev/null | grep json)" ] && break; sleep 0.1; done; }
CFW="$(winpath "$WORK/cf/web")"; CFO="$(winpath "$WORK/cf/other")"; CFA="$(winpath "$WORK/cf/api")"
start "$WORK/cf/web" 'npm install >/dev/null 2>&1; sleep 5'
O="$(hook_out Bash "npm run build" 0 "$CFW")"
check "build while install runs -> deny" '[ "$(decision "$O")" = deny ] && [[ "$(reason "$O")" == *"being installed"* ]]'
check "test while install runs -> deny" '[ "$(decision "$(hook_out Bash "npm test" 0 "$CFW")")" = deny ]'
check "same build in another project -> allowed" '[ "$(decision "$(hook_out Bash "npm run build" 0 "$CFO")")" != deny ]'
check "unrelated command same project -> untouched" '[ -z "$(hook_out Bash "git status" 0 "$CFW")" ]'
wait; reset_state
start "$WORK/cf/web" 'npm run build >/dev/null 2>&1; sleep 5'
O="$(hook_out Bash "npm install lodash" 0 "$CFW")"
check "install while build runs -> deny" '[ "$(decision "$O")" = deny ] && [[ "$(reason "$O")" == *"swap node_modules"* ]]'
check "next dev while next build runs -> deny" '[ "$(decision "$(hook_out Bash "npm run dev" 0 "$CFW")")" = deny ]'
wait; reset_state
start "$WORK/cf/web" 'npm run dev >/dev/null 2>&1; sleep 5'
O="$(hook_out Bash "npm run build" 0 "$CFW")"
check "next build while next dev runs -> deny (.next)" '[ "$(decision "$O")" = deny ] && [[ "$(reason "$O")" == *".next"* ]]'
O="$(hook_out Bash "npm install lodash" 0 "$CFW")"
check "install while dev server runs -> allowed with warning" '[ "$(decision "$O")" != deny ] && [[ "$(field "$O" o.additionalContext)" == *"restart it afterwards"* ]]'
check "bypass marker -> allowed" '[ "$(decision "$(hook_out Bash "AGENT_TRAFFIC_ALLOW=1 npm run build" 0 "$CFW")")" != deny ]'
wait; reset_state
start "$WORK/cf/api" 'dotnet run >/dev/null 2>&1; sleep 5'
O="$(hook_out Bash "dotnet build" 0 "$CFA")"
check "dotnet build while app runs -> deny (locked dlls)" '[ "$(decision "$O")" = deny ] && [[ "$(reason "$O")" == *"locks the build output"* ]]'
wait; reset_state

echo "T21 git guard: other agents in the same working tree"
reset_state
GR="$WORK/repo"; mkdir -p "$GR/src" && cd "$GR" && git init -q && git config user.email t@t && git config user.name t \
  && echo a > src/a.txt && git add . && git commit -qm init && git worktree add -q "$WORK/repo-wt" -b wt 2>/dev/null; cd "$WORK"
GRW="$(winpath "$GR")"; GTW="$(winpath "$WORK/repo-wt")"
# act <session> <tool> <file-or-command> <cwd>: session activity through the real hooks
edit_as() { node -e 'const [s,f,cwd]=process.argv.slice(1);process.stdout.write(JSON.stringify({hook_event_name:"PostToolUse",session_id:s,cwd,tool_name:"Edit",tool_input:{file_path:f}}))' "$1" "$2" "$3" | node "$ROOT/hooks/activity.js"; }
git_as() { node -e 'const [s,c,cwd]=process.argv.slice(1);process.stdout.write(JSON.stringify({tool_name:"Bash",session_id:s,cwd,tool_input:{command:c}}))' "$1" "$2" "$3" | node "$ROOT/hooks/pretooluse.js"; }
gd() { decision "$(git_as "$@")"; }
check "alone in repo: checkout allowed" '[ "$(gd S1 "git checkout -b feat" "$GRW")" != deny ]'
edit_as S2 "$GRW/src/a.txt" "$GRW"
O="$(git_as S1 "git checkout main" "$GRW")"
check "other session edited here -> checkout denied" '[ "$(decision "$O")" = deny ] && [[ "$(reason "$O")" == *"Edit a.txt"*"git worktree add"* ]]'
for c in "git switch main" "git stash" "git reset --hard HEAD" "git clean -fd" "git pull" "git rebase main" "git restore src/a.txt" "git add -A" "git add ." "git commit -am wip" "cd src && git checkout main"; do
  check "denied: $c" '[ "$(gd S1 "$c" "$GRW")" = deny ]'
done
for c in "git status" "git diff" "git log --oneline" "git stash list" "git reset HEAD~0 --soft" "git add src/a.txt" "git commit -m msg -- src/a.txt" "git fetch" "git branch -a"; do
  check "allowed: $c" '[ "$(gd S1 "$c" "$GRW")" != deny ]'
done
O="$(git_as S1 "git add -A" "$GRW")"
check "add-all tip says stage own files" '[[ "$(reason "$O")" == *"only your own files"* ]]'
check "git -C into the shared repo -> denied" '[ "$(gd S1 "git -C $GRW checkout main" "$(winpath "$WORK")")" = deny ]'
rm -f "$AGENT_TRAFFIC_HOME/sessions/S1.json"  # S1's own git calls above made it active here too
check "same session is never blocked by itself" '[ "$(gd S2 "git checkout main" "$GRW")" != deny ]'
rm -f "$AGENT_TRAFFIC_HOME/sessions/S1.json"
check "separate worktree -> allowed" '[ "$(gd S1 "git checkout main" "$GTW")" != deny ]'
check "quoted text is not a git command" '[ "$(gd S1 "echo \"git checkout main\"" "$GRW")" != deny ]'
check "bypass marker -> allowed" '[ "$(gd S1 "AGENT_TRAFFIC_ALLOW=1 git checkout main" "$GRW")" != deny ]'
node -e 'process.stdout.write(JSON.stringify({hook_event_name:"SessionEnd",session_id:"S2"}))' | node "$ROOT/hooks/activity.js"
check "after the other session ended -> allowed" '[ "$(gd S1 "git checkout main" "$GRW")" != deny ]'
mkdir -p "$AGENT_TRAFFIC_HOME/sessions"
GKEY="$(node -e 'console.log(require(process.argv[2]).normCwd(process.argv[1]))' "$GRW" "$(winpath "$ROOT")/core/command.js")"
s3() { echo "{\"id\":\"S3\",\"repos\":{\"$GKEY\":{\"at\":$1,\"what\":\"old\"}}}" > "$AGENT_TRAFFIC_HOME/sessions/S3.json"; }
s3 $(( $(now) - 5 * 3600000 ))
check "idle longer than the window (5 h > 4 h) -> allowed" '[ "$(gd S1 "git checkout main" "$GRW")" != deny ]'
s3 $(( $(now) - 2 * 3600000 ))
check "idle 2 h but session not ended -> still protected" '[ "$(gd S1 "git checkout main" "$GRW")" = deny ]'
check "deny tells the agent not to override on its own" '[[ "$(reason "$(git_as S1 "git checkout main" "$GRW")")" == *"Do not override this on your own"* ]]'
s3 $(( $(now) - 25 * 3600000 ))
gd S1 "git checkout main" "$GRW" >/dev/null
check "session file of a crashed session (25 h old) is pruned" '[ ! -e "$AGENT_TRAFFIC_HOME/sessions/S3.json" ]'
git_as S2 "npm test" "$GRW" >/dev/null
check "activity via a shell command counts too" '[ "$(gd S1 "git stash" "$GRW")" = deny ]'

echo "T22 conflict guard in a monorepo workspace"
reset_state
WS="$WORK/ws"; mkdir -p "$WS/packages/web" "$WS/packages/api" "$WORK/solo"
echo '{"name":"ws","private":true,"workspaces":["packages/*"]}' > "$WS/package.json"
echo '{"name":"web","scripts":{"build":"vite build"}}' > "$WS/packages/web/package.json"
echo '{"name":"api","scripts":{"build":"tsc -p ."}}' > "$WS/packages/api/package.json"
echo '{"name":"solo","scripts":{"build":"vite build"}}' > "$WORK/solo/package.json"
start "$WS" 'npm install >/dev/null 2>&1; sleep 5'
O="$(hook_out Bash "npm run build" 0 "$(winpath "$WS/packages/web")")"
check "build in a package while the workspace root installs -> deny" '[ "$(decision "$O")" = deny ]'
check "reason names the workspace" '[[ "$(reason "$O")" == *"in this workspace"* ]]'
check "unrelated project outside the workspace -> allowed" '[ "$(decision "$(hook_out Bash "npm run build" 0 "$(winpath "$WORK/solo")")")" != deny ]'
wait; reset_state
start "$WS/packages/api" 'npm run build >/dev/null 2>&1; sleep 5'
check "install at the workspace root while a package builds -> deny" '[ "$(decision "$(hook_out Bash "npm install" 0 "$(winpath "$WS")")")" = deny ]'
wait; reset_state

for p in ${P1:-} ${P3:-}; do killport $p; done  # never leave test servers behind
echo "RESULT: $PASS passed, $FAIL failed"
cd /
rm -rf "$AGENT_TRAFFIC_HOME" "$WORK"
[ $FAIL -eq 0 ]
