@echo off
cd /d "%~dp0\.."
start /b node scripts/cctv-bridge.mjs
start /b node scripts/cabin-print-agent.mjs
