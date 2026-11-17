@echo off
REM ALPHA GENESIS - Windows startup (paper trading only). Requires Python 3.11+ on PATH ("py" launcher).
REM The dashboard is pre-built in the release zip, so Node.js is not needed.
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  py -3 -m venv .venv || (echo Python 3.11+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
  call ".venv\Scripts\activate.bat"
  python -m pip install --upgrade pip
  pip install -r requirements.txt || (echo Dependency installation failed. & pause & exit /b 1)
  pip install -e backend || (pause & exit /b 1)
) else (
  call ".venv\Scripts\activate.bat"
)
if exist ".env" (for /f "usebackq tokens=1,* delims==" %%A in (".env") do (if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"))
if "%AG_DATA_DIR%"=="" set "AG_DATA_DIR=%~dp0data"
echo.
echo ALPHA GENESIS is starting. Open http://127.0.0.1:8000 in your browser. Press Ctrl+C to stop.
echo First start builds the data set and can take a minute or two.
echo.
cd backend
python -W ignore -m alpha_genesis.cli serve --host 127.0.0.1 --port 8000
pause
