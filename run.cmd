@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  DSH compatibility pre-check -- double-click to run.
rem
rem  Keep this file ASCII-only: cmd.exe mis-parses UTF-8 CJK inside a batch
rem  file even after `chcp 65001`, which turns echo lines into "not recognized
rem  as an internal or external command". All Chinese output comes from
rem  hook.js (Node writes UTF-8, which cmd then renders correctly).
rem
rem  Any argument is passed through to hook.js:
rem     run.cmd --to 0.2.3-rc.1     pin the target version (no registry query)
rem     run.cmd --postflight        fast compose check only (~2s)
rem     run.cmd --no-client          skip the browser probe
rem ---------------------------------------------------------------------------

echo ============================================================
echo   DSH compatibility pre-check
echo ============================================================

if not exist "dist\hook.js" goto :notbuilt

node "dist\hook.js" --auto --profile "%USERPROFILE%\.dsh\profiles\desktop" %*
set RC=%ERRORLEVEL%

echo.
echo ------------------------------------------------------------
if "%RC%"=="0" echo   RESULT: PASS  - safe to update
if "%RC%"=="1" echo   RESULT: BLOCK - do not update now; see the report
if "%RC%"=="2" echo   RESULT: WARN  - update possible but risky; see the report
if not "%RC%"=="0" if not "%RC%"=="1" if not "%RC%"=="2" echo   RESULT: ERROR %RC% - check did not finish (fail-open)
echo ------------------------------------------------------------

echo Full report (when one was produced): .\out\ - newest folder, report.md

echo.
pause
exit /b %RC%

:notbuilt
echo [!] dist\hook.js not found. Build it first:
echo       npm install
echo       npm run build
echo.
pause
exit /b 2
