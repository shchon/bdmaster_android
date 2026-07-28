$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " BondMaster - Local Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Backend : http://127.0.0.1:8000/health"
Write-Host "Frontend: http://localhost:3000"
Write-Host ""

# Start backend
Write-Host "[1/2] Starting backend..." -ForegroundColor Yellow
$backend = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload" -PassThru

Start-Sleep -Seconds 3

# Start frontend
Write-Host "[2/2] Starting frontend..." -ForegroundColor Yellow
$frontend = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; npm run dev" -PassThru

Write-Host ""
Write-Host "Both servers launched." -ForegroundColor Green
Write-Host "Close the server windows to stop."
Write-Host ""
Read-Host "Press Enter to exit this launcher"
