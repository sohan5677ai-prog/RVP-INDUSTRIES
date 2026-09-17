@echo off
cd /d "%~dp0\.."
if exist "C:\Program Files\nodejs\node.exe" (
    "C:\Program Files\nodejs\node.exe" scripts\cabin-supervisor.mjs
) else (
    node scripts\cabin-supervisor.mjs
)
