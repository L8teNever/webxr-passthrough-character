@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Holt das Projekt von GitHub (clone/pull) und startet es LAN-weit via Docker Compose.

set "REPO_URL=https://github.com/L8teNever/webxr-passthrough-character.git"
set "REPO_NAME=webxr-passthrough-character"
set "INSTALL_DIR=%USERPROFILE%\%REPO_NAME%"

echo.
echo === WebXR von GitHub holen + lokal starten (LAN) ===
echo.

rem Git noetig fuer Clone/Pull
where git >nul 2>&1
if errorlevel 1 (
  echo FEHLER: git wurde nicht gefunden.
  echo Bitte Git installieren: https://git-scm.com/download/win
  pause
  exit /b 1
)

docker version >nul 2>&1
if errorlevel 1 (
  echo FEHLER: Docker ist nicht erreichbar.
  echo Bitte Docker Desktop starten und erneut versuchen.
  pause
  exit /b 1
)

rem Wenn diese .bat schon im geklonten Repo liegt: dort arbeiten.
rem Sonst nach %%USERPROFILE%%\webxr-passthrough-character klonen.
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "USE_DIR="

if exist "%SCRIPT_DIR%\.git" if exist "%SCRIPT_DIR%\docker-compose.yml" (
  set "USE_DIR=%SCRIPT_DIR%"
  echo Repo-Ordner ^(neben der .bat^): !USE_DIR!
) else if exist "%INSTALL_DIR%\.git" if exist "%INSTALL_DIR%\docker-compose.yml" (
  set "USE_DIR=%INSTALL_DIR%"
  echo Vorhandenes Repo: !USE_DIR!
) else (
  echo Klone von GitHub:
  echo   %REPO_URL%
  echo nach:
  echo   %INSTALL_DIR%
  echo.
  git clone "%REPO_URL%" "%INSTALL_DIR%"
  if errorlevel 1 (
    echo FEHLER: git clone fehlgeschlagen.
    pause
    exit /b 1
  )
  set "USE_DIR=%INSTALL_DIR%"
)

cd /d "!USE_DIR!"
if errorlevel 1 (
  echo FEHLER: Kann nicht nach !USE_DIR! wechseln.
  pause
  exit /b 1
)

echo.
echo Hole neueste Version von GitHub ^(git pull^)...
git pull --ff-only origin main
if errorlevel 1 (
  echo WARNUNG: git pull fehlgeschlagen — starte mit lokalem Stand.
) else (
  echo Repo ist aktuell.
)

echo.
echo Ordner: %CD%
echo.

rem Erste IPv4-LAN-Adresse (ohne 127.x) fuer Zertifikat + Anzeige
set "HOST_IP="
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "IP=%%A"
  set "IP=!IP: =!"
  echo !IP! | findstr /b "127." >nul
  if errorlevel 1 if not defined HOST_IP set "HOST_IP=!IP!"
)

if not defined HOST_IP (
  echo WARNUNG: Keine LAN-IP gefunden. Zertifikat ohne HOST_IP.
) else (
  echo LAN-IP: !HOST_IP!
  echo.
  echo Im Browser / auf der Quest:
  echo   https://!HOST_IP!:8000
  echo.
  echo Hinweis: Selbstsigniertes Zertifikat einmalig akzeptieren.
)

echo.
echo Bindet auf 0.0.0.0:8000 — erreichbar von allen Geraeten im gleichen WLAN/LAN.
echo Zum Beenden: Strg+C
echo.

rem HOST_IP an docker compose durchreichen (SAN im SSL-Zertifikat)
docker compose up --build

echo.
pause
endlocal
