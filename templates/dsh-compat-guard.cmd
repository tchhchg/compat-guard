@echo off
rem ===========================================================================
rem  dsh-compat-guard — pre-install hook entry point.
rem
rem  The installer calls THIS file and branches on the exit code:
rem     0 = pass   (continue install)
rem     1 = block  (abort install, roll back staged files)
rem     2 = warn   (continue, show warning)   <- also timeout / fail-open / checker fault
rem
rem  Environment contract (set by the installer):
rem     DSH_FROM_VERSION      occupied host version      (required)
rem     DSH_TO_VERSION        target host version        (required)
rem     DSH_PROFILE_DIR       profile to check           (required, e.g. %USERPROFILE%\.dsh\profiles\desktop)
rem     DSH_TARGET_DIR        unpacked new version dir   (optional)
rem     DSH_GUARD_TIMEOUT_MS  budget, default 180000     (optional)
rem     DSH_GUARD_OUT         report root                (optional, default <repo>\out)
rem     DSH_GUARD_NODE        explicit node.exe or name  (optional)
rem     DSH_GUARD_EXTRA       extra CLI flags, e.g. --no-client --no-runtime  (optional)
rem
rem  stdout contract: the LAST line emitted by hook.js is a single-line JSON
rem  object. It is written as pure ASCII (\uXXXX escapes) so any installer code
rem  page can parse it — report paths contain non-ASCII characters.
rem
rem  Timeout boundary, stated honestly: the hard budget is enforced inside
rem  hook.js by its own watchdog (timeout + 30s), which calls process.exit and is
rem  not subject to event-loop starvation. This .cmd adds no second timer; on a
rem  total node failure Windows returns 9009/1 and the rem lines below map that to
rem  the fail-open code so the installer can never be blocked by the checker.
rem ===========================================================================
setlocal EnableExtensions

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

rem --- 1) Resolve a Node runtime: explicit override -> bundled -> PATH -------
rem  An explicit DSH_GUARD_NODE that does not resolve is NOT fatal: fall through
rem  to the next candidate instead of failing the whole install.
if not defined DSH_GUARD_NODE goto :try_bundled
if exist "%DSH_GUARD_NODE%" goto :have_node
where "%DSH_GUARD_NODE%" >nul 2>nul
if not errorlevel 1 goto :have_node
1>&2 echo [compat-guard] DSH_GUARD_NODE="%DSH_GUARD_NODE%" does not resolve; falling back
set "DSH_GUARD_NODE="

:try_bundled
if defined DSH_GUARD_NODE goto :have_node
set "BUNDLED=%HERE%\..\runtime\node\node.exe"
if exist "%BUNDLED%" set "DSH_GUARD_NODE=%BUNDLED%"
if defined DSH_GUARD_NODE goto :have_node

where node >nul 2>nul
if errorlevel 1 goto :no_node
set "DSH_GUARD_NODE=node"

:have_node
rem --- 2) The build must exist; a missing dist is a checker fault, not a verdict
set "ENTRY=%HERE%\..\dist\hook.js"
if not exist "%ENTRY%" goto :not_built

rem --- 3) Run. %DSH_GUARD_EXTRA% is word-split on purpose (caller-controlled).
set "RC=2"
"%DSH_GUARD_NODE%" "%ENTRY%" %DSH_GUARD_EXTRA%
set "RC=%ERRORLEVEL%"

rem --- 4) Anything outside the contract degrades to fail-open --------------
if "%RC%"=="0" exit /b 0
if "%RC%"=="1" exit /b 1
if "%RC%"=="2" exit /b 2
1>&2 echo [compat-guard] unexpected exit code %RC%; treating as warn (fail-open)
echo {"verdict":"warn","overall":"UNKNOWN","reason":"unexpected-exit-%RC%","reportPath":null}
exit /b 2

:no_node
1>&2 echo [compat-guard] no node runtime found; skipping compatibility check
echo {"verdict":"warn","overall":"UNKNOWN","reason":"node-not-found","reportPath":null}
exit /b 2

:not_built
1>&2 echo [compat-guard] dist\hook.js is missing; run "npm run build" in the compat-guard repo
echo {"verdict":"warn","overall":"UNKNOWN","reason":"dist-not-built","reportPath":null}
exit /b 2
