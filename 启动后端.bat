@echo off
cd /d "%~dp0"
echo Starting BondMaster Backend on http://127.0.0.1:8000 ...
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
pause
