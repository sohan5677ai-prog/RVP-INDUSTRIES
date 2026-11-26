@echo off
REM Nightly database backup (Phase 9). Registered with Windows Task Scheduler -
REM see docs/security/RUNBOOK.md. A .cmd wrapper rather than a long schtasks
REM /TR string, because quoting a cd-and-run one-liner through schtasks is the
REM kind of thing that silently registers a task which never works.
cd /d "%~dp0\.."
node scripts\backup-database.mjs >> "%OneDrive%\RVP-Backups\backup.log" 2>&1
