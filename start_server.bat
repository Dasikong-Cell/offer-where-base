@echo off
chcp 65001 >nul
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1
cd /d "%ROOT%"
set PORT=4400

REM ============================================================
REM Arm the RESIDENT watchers. This is a DELIBERATE opt-in:
REM   merely starting the backend must NOT authorise outbound
REM   messages. Without the line below, the auto-reply watcher
REM   starts messaging HRs about 11.7 min after launch, and the
REM   auto-apply watcher really applies about 15 min after
REM   launch -- and NEITHER can be undone.
REM   Tests and audit scripts spawn server/index.ts directly, so
REM   they never arm it. See AUTO_BOOTSTRAP in server/index.ts.
REM ============================================================
set OW_AUTO_BOOTSTRAP=1
echo Starting backend on PORT=4400, logging to server.log ...
"%NODE%" "%ROOT%node_modules\tsx\dist\cli.mjs" server/index.ts >> server.log 2>&1
