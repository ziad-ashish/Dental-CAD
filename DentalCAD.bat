@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>&1
if not errorlevel 1 (
  python main.py
) else (
  where py >nul 2>&1
  if not errorlevel 1 (
    py -3 main.py
  ) else (
    echo Python 3 was not found. Install Python 3.10+ and run this file again.
    pause
    exit /b 2
  )
)
if errorlevel 1 pause
