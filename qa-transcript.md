# QA evidence: duplicate "Compacting..." markers (fix/compaction-duplicate-markers)

Worktree: /Users/tomg/.paseo/worktrees/2qsrta6t/fix-compaction-duplicate-markers
Dev daemon: 127.0.0.1:6768, isolated PASEO_HOME at <worktree>/.dev/paseo-home
Production daemon on 6767 (PID 9915) was NEVER touched. Verified before and after every restart.
Claude Code binary under test: 2.1.263

## 0. Confirm the 30s heartbeat still exists in the INSTALLED binary (2.1.263)

The root-cause decompile came from 2.1.261. Verified it is still present in 2.1.263:

    $ strings -a /Users/tomg/.local/share/claude/versions/2.1.263 | grep -o '.\{160\}status:"compacting".\{80\}'
    ...var Lvo=30000;function g7(e){let t=setInterval(Fvo,Lvo,e);return()=>clearInterval(t)}
    function Fvo(e){Bnr(),e?.({type:"sdk_status",status:"compacting"})}...

Identifiers renamed (Ivo->Lvo, Mvo->Fvo, d7->g7); behavior identical: a 30000ms setInterval
re-emitting {type:"sdk_status",status:"compacting"}.

Also confirmed the MANUAL /compact path reaches that heartbeat. The /compact command handler
emits one "compacting" itself and then delegates to `pfn`, which starts the interval
unconditionally:

    async function pfn(e,t,r){ ... let _=r?.trigger??"auto",E=zP(),C=g7(t.toolUseContext.onCompactEvent),I;
    try{ ... }finally{C()}

Caveat found while reading the binary: if Claude has a PRECOMPUTED compaction cached, /compact
takes the `Cjt(...)` branch instead of `pfn` and returns fast with no heartbeat. In that case the
bug cannot appear. Our run took the `pfn` branch.

## 1. Environment

    $ lsof -nP -iTCP:6767 -sTCP:LISTEN     # prod, protected
    Paseo 9915 tomg 26u IPv4 ... TCP 127.0.0.1:6767 (LISTEN)
    $ lsof -nP -iTCP:6768 -sTCP:LISTEN     # dev, free at start
    none

    $ npm run cli -- daemon status
    Server ID         srv_d15bRgNqQsEv
    Listen            127.0.0.1:6768
    Home              <worktree>/.dev/paseo-home
    Providers: Claude available (daemon)

Note: the CLI inherits PASEO_AGENT_ID from the surrounding Paseo agent and then fails with
"Caller agent ... not found" against the dev daemon. All CLI calls below therefore run as:
    env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_CLI npm run cli -- ...

## 2. Context corpus (kept out of the repo)

    $ cat packages/server/src/server/session.ts \
          packages/server/src/server/agent/providers/codex-app-server-agent.ts \
          packages/server/src/server/agent/providers/opencode-agent.ts \
          packages/server/src/server/agent/agent-manager.ts \
          packages/client/src/daemon-client.ts \
          packages/app/src/screens/workspace/workspace-screen.tsx > _all.txt
    1194720 bytes
    $ split -l 1100 _all.txt part-      # -> 34 chunks in /tmp/compaction-qa/bigctx

The agent's cwd was /tmp/compaction-qa/bigctx, never the repo working tree.

## 3. BEFORE capture (fix reverted)

The fix was removed by restoring the committed version of the file (the shared stash stack is
used by other worktrees, so `git stash` was deliberately avoided):

    $ cp packages/server/src/server/agent/providers/claude/agent.ts /tmp/compaction-qa/agent.ts.FIXED
    $ git show HEAD:packages/server/src/server/agent/providers/claude/agent.ts > /tmp/compaction-qa/agent.ts.UNFIXED
    $ cp /tmp/compaction-qa/agent.ts.UNFIXED packages/server/src/server/agent/providers/claude/agent.ts
    $ grep -c compactionMarkerOpen packages/server/src/server/agent/providers/claude/agent.ts
    0

Confirmed the unguarded push was live before starting the daemon:

    4256:      if (status === "compacting") {
    4257-        this.compacting = true;
    4258-        events.push({
    4259-          type: "timeline",
    4260-          item: { type: "compaction", status: "loading" },
    4261-          provider: "claude",
    4262-        });
    4263-      }

    $ npm run dev            # dev daemon, unfixed code, listening on 6768

Agent created (cwd = scratch corpus, not the repo):

    $ env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_CLI npm run cli -- run -d \
        --provider claude --mode bypassPermissions --title compaction-qa-BEFORE \
        --workspace wks_6c4367914767f3a4 "Read these files in full ... part-aa.ts .. part-ap.ts"
    acd77889-fd8e-4bed-80fc-f1c81fc70eca  running  claude  /tmp/compaction-qa/bigctx

    $ npm run cli -- send acd77889-... "/compact"

Timeline observed live in the web app (http://localhost:8081, connected to the dev daemon):

    t = 12s   1 x "Compacting..."
    t = 30s   2 x "Compacting..."     <- heartbeat #1
    t = 43s   2 x "Compacting..."
    t = 1m01s 3 x "Compacting..."     <- heartbeat #2
    t = 1m32s 4 x "Compacting..."     <- heartbeat #3
    done      1 x "Context manually compacted" + 3 x "Compacting..." STUCK

compact_boundary record from the Claude transcript
(~/.claude/projects/-private-tmp-compaction-qa-bigctx/*.jsonl):

    { "trigger": "manual", "preTokens": 304441, "durationMs": 112921, "postTokens": 19592 }

112921ms crosses t=30/60/90, so 1 initial + 3 heartbeats = 4 markers opened, 1 resolved,
3 left spinning forever. Daemon log corroborates: ws_slow_request wait_for_finish_request
durationMs 113456.

RESULT: reproduced. 3 stuck "Compacting..." rows.
Screenshot: /tmp/compaction-qa/BEFORE-final-stuck-rows.png

## 4. Restore the fix and restart the dev daemon

`packages/server/scripts/dev-runner.ts` has no watcher (grep for watch/restart/chokidar returns
nothing) and the daemon log showed uptimeSeconds still climbing from the original start, so the
daemon does NOT hot-reload. It had to be restarted explicitly for the fix to take effect.

    $ cp /tmp/compaction-qa/agent.ts.FIXED packages/server/src/server/agent/providers/claude/agent.ts
    $ grep -c compactionMarkerOpen packages/server/src/server/agent/providers/claude/agent.ts
    5

Stopped ONLY the dev daemon process tree, with an explicit guard against the production PID:

    $ PROD_PID=$(lsof -nP -iTCP:6767 -sTCP:LISTEN -t)     # 9915
    $ for p in 74776 74834 74836 74651 74654 74777 74482 74441; do
        [ "$p" = "$PROD_PID" ] && continue; kill $p; done
    killed 74776 74834 74836 74651 74654 74777 74482 74441
    $ lsof -nP -iTCP:6768 -sTCP:LISTEN   -> 6768 free
    $ lsof -nP -iTCP:6767 -sTCP:LISTEN   -> Paseo 9915 ... 127.0.0.1:6767 (LISTEN)   [prod alive]

    $ npm run dev
    $ npm run cli -- daemon status
    Listen  127.0.0.1:6768
    PID     17912
    Started 2026-09-06T10:07:34.678Z          [fresh process, fixed code]

## 5. AFTER capture (fix applied)

Fresh agent, same 16-file corpus, same workspace, so the two runs are comparable:

    $ env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_CLI npm run cli -- run -d \
        --provider claude --mode bypassPermissions --title compaction-qa-AFTER \
        --workspace wks_6c4367914767f3a4 "Read these files in full ... part-aa.ts .. part-ap.ts"
    c632dbea-363d-400d-a870-22f90d1c3efa  running  claude  /tmp/compaction-qa/bigctx

Context grown to a comparable size before compacting (BEFORE run was 304441):

    status=running tokens=66778
    status=running tokens=202334
    status=running tokens=239668
    status=running tokens=277548
    REACHED_TARGET tokens=294746

    $ npm run cli -- stop c632dbea-...      INTERRUPTED -> idle
    $ npm run cli -- send c632dbea-... "/compact"

Timeline observed live in the web app, same viewport, fixed daemon:

    t = 7s     1 x "Compacting..."
    t = 38s    1 x "Compacting..."     <- heartbeat #1 fired, NO new marker
    t = 52s    1 x "Compacting..."
    t = 1m05s  1 x "Compacting..."     <- heartbeat #2 fired, NO new marker
    t = 1m13s  1 x "Compacting..."
    t = 1m35s  1 x "Compacting..."     <- heartbeat #3 fired, NO new marker
    done       1 x "Context manually compacted", zero leftover spinners

compact_boundary record:

    { "trigger": "manual", "preTokens": 312666, "durationMs": 98371, "postTokens": 9446 }

98371ms > 90s, so all three heartbeats (t=30/60/90) fired in this run too - the same
conditions that produced 4 markers before now produce exactly 1.

RESULT: exactly one compaction row, resolved to "Context manually compacted".
Screenshot: /tmp/compaction-qa/AFTER-final-single-row.png

## 6. Side-by-side

| | BEFORE (unfixed) | AFTER (fixed) |
|---|---|---|
| preTokens | 304441 | 312666 |
| durationMs | 112921 | 98371 |
| heartbeats fired (t=30/60/90) | 3 | 3 |
| compaction markers opened | 4 | 1 |
| rows after completion | 1 resolved + 3 stuck "Compacting..." | 1 resolved, 0 stuck |

## 7. Screenshots

    /tmp/compaction-qa/BEFORE-final-stuck-rows.png     <- the bug: 1 resolved + 3 stuck
    /tmp/compaction-qa/AFTER-final-single-row.png      <- fixed: exactly 1 resolved
    /tmp/compaction-qa/before-t45-compacting.png       (1 row, t=12s)
    /tmp/compaction-qa/before-t70-compacting.png       (2 rows, t=30s)
    /tmp/compaction-qa/before-t100-compacting.png      (2 rows, t=43s)
    /tmp/compaction-qa/before-t95-compacting.png       (3 rows, t=1m01s)
    /tmp/compaction-qa/before-t160-compacting.png      (4 rows, t=1m32s)
    /tmp/compaction-qa/after-t40-compacting.png        (1 row, t=7s)
    /tmp/compaction-qa/after-mid-compacting.png        (1 row, t=38s)
    /tmp/compaction-qa/after-t80-compacting.png        (1 row, t=52s)
    /tmp/compaction-qa/after-t100-compacting.png       (1 row, t=1m05s)
    /tmp/compaction-qa/after-t130-compacting.png       (1 row, t=1m13s)
    /tmp/compaction-qa/after-t150-compacting.png       (1 row, t=1m35s)
    /tmp/compaction-qa/00-agent-building-context.png   (context build in progress)

Screenshot filenames encode the wall-clock at which the shot was requested, not the
compaction timer; the parenthesised timer value is the one rendered in the image.

## 8. Repo hygiene and commit

The npm install had modified package-lock.json; reverted so it is not part of the change.
Playwright writes only into the worktree, so .playwright-mcp was used and then deleted
(screenshots copied to /tmp/compaction-qa first). One early screenshot landed in the repo
root because a relative filename was passed; it was moved out immediately.

    $ git checkout -- package-lock.json
    $ rm -rf .playwright-mcp
    $ git status --short
     M packages/server/src/server/agent/providers/claude/agent.test.ts
     M packages/server/src/server/agent/providers/claude/agent.ts

Verified the file swapping left the fix byte-identical to what was there at the start:

    $ diff -q packages/server/.../claude/agent.ts /tmp/compaction-qa/agent.ts.FIXED
    IDENTICAL to the fixed version   (sha256 c6e8c6fe7f964081...)

    $ npx vitest run packages/server/src/server/agent/providers/claude/agent.test.ts --bail=1
    Test Files  1 passed (1)
    Tests  76 passed (76)
    exit: 0

Committed locally, NOT pushed, no PR, no issue:

    e4ec00bbe fix(claude): open a single compaction marker per compaction
     .../claude/agent.test.ts   | 37 ++++++++++
     .../claude/agent.ts        | 19 ++++---
     2 files changed, 51 insertions(+), 5 deletions(-)

Pre-commit hooks ran and passed: lint (0 warnings 0 errors), format:check (all correct),
typecheck (all workspaces).

Final state: production daemon 6767 (PID 9915) alive and untouched throughout. Dev daemon
6768 and Expo on 8081 left running.
