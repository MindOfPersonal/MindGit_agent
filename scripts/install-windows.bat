@echo off
REM MindGit Agent - Windows Installer  (v2.4)
REM Run as Administrator for system-wide install, or without for user install
REM
REM Usage:
REM   install-windows.bat [--system|--user] [--dir=PATH] [--coordinator=URL] [--node-key=KEY]
REM
REM Works in two scenarios:
REM   1) Full agent map present next to this script  - files are copied locally.
REM   2) Standalone script only  - the agent package (mindgit-agent.tar.gz) is
REM      downloaded from COORDINATOR_URL. Requires Windows 10 1803+ (tar + curl).

setlocal enabledelayedexpansion

echo [VERSION] install-windows.bat v2.4
echo.
echo   MindGit Agent - Windows Installer
echo.

REM ---------------- Parse arguments ----------------
set "COORDINATOR_URL="
set "NODE_KEY="
set "CUSTOM_DIR="
set "SYSTEM_INSTALL=false"

:PARSE_ARGS
if "%~1"=="" goto :ARGS_DONE
if /i "%~1"=="--system" set "SYSTEM_INSTALL=true"
if /i "%~1"=="--user" set "SYSTEM_INSTALL=false"
if /i "%~1"=="--help" goto :SHOW_HELP
set "_arg=%~1"
if /i "!_arg:~0,14!"=="--coordinator=" set "COORDINATOR_URL=!_arg:~14!"
if /i "!_arg:~0,10!"=="--node-key=" set "NODE_KEY=!_arg:~10!"
if /i "!_arg:~0,6!"=="--dir=" set "CUSTOM_DIR=!_arg:~6!"
shift
goto :PARSE_ARGS

:SHOW_HELP
echo Usage: install-windows.bat [options]
echo.
echo Options:
echo   --system           Install system-wide - requires Administrator
echo   --user             Install for current user - default
echo   --dir=PATH         Custom install directory
echo   --coordinator=URL  Coordinator URL - e.g. https://minddev.nl
echo   --node-key=KEY     Node key from dashboard - Nodes ^> Add Node
echo   --help             Show this help
exit /b 0

:ARGS_DONE

REM Strip trailing slash from coordinator URL
if defined COORDINATOR_URL (
    if "!COORDINATOR_URL:~-1!"=="/" set "COORDINATOR_URL=!COORDINATOR_URL:~0,-1!"
)

REM If arguments did not get through (e.g. PowerShell mangling), ask interactively.
if not defined COORDINATOR_URL (
    echo.
    set /p COORDINATOR_URL="Coordinator URL [default: https://minddev.nl]: "
)
if "%COORDINATOR_URL%"=="" set "COORDINATOR_URL=https://minddev.nl"
if not defined NODE_KEY (
    set /p NODE_KEY="Enter node key - from dashboard - Nodes ^> Add Node: "
)

REM ---------------- Prerequisites ----------------
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

REM Read node version without for/f-inline-commands (more robust).
set "NODE_VERSION="
set "NODE_MAJOR="
node --version > "%TEMP%\mindgit-nodever.txt" 2>nul
if exist "%TEMP%\mindgit-nodever.txt" set /p NODE_VERSION=< "%TEMP%\mindgit-nodever.txt"
if exist "%TEMP%\mindgit-nodever.txt" del "%TEMP%\mindgit-nodever.txt" >nul 2>&1
set "NODE_VERSION=%NODE_VERSION:v=%"
if not defined NODE_VERSION goto :NODE_VERSION_UNKNOWN
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR goto :NODE_VERSION_UNKNOWN
if %NODE_MAJOR% lss 18 goto :NODE_TOO_OLD
echo [OK] Node.js %NODE_VERSION% found
goto :NODE_CHECK_DONE

:NODE_TOO_OLD
echo [ERROR] Node.js 18+ required. Current version: %NODE_VERSION%
pause
exit /b 1

:NODE_VERSION_UNKNOWN
echo [WARN] Could not determine Node.js version - skipping version check.
goto :NODE_CHECK_DONE

:NODE_CHECK_DONE

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git is not installed or not in PATH.
    echo Please install Git from https://git-scm.com/
    pause
    exit /b 1
)
echo [OK] Git found

REM ---------------- Determine install location ----------------
if defined CUSTOM_DIR (
    set "INSTALL_DIR=%CUSTOM_DIR%"
) else (
    set "INSTALL_DIR=%LOCALAPPDATA%\MindGitAgent"
    if "%SYSTEM_INSTALL%"=="true" (
        net session >nul 2>nul
        if %errorlevel% neq 0 (
            echo [ERROR] System-wide install requested but not running as Administrator.
            echo Right-click this file and choose "Run as administrator".
            pause
            exit /b 1
        )
        set "INSTALL_DIR=%PROGRAMFILES%\MindGitAgent"
    )
)

REM Vraag interactief naar een eigen installatiemap (behalve bij --system/--dir).
if not defined CUSTOM_DIR (
    if not "%SYSTEM_INSTALL%"=="true" (
        echo.
        set /p CHOOSE_DIR="Install directory [default: %INSTALL_DIR%]: "
        if defined CHOOSE_DIR set "INSTALL_DIR=%CHOOSE_DIR%"
    )
)

echo [INFO] Installing to: %INSTALL_DIR%

REM ---------------- Create install directory ----------------
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

REM ---------------- Get the agent files ----------------
set "LOCAL_AGENT_INDEX=%~dp0..\index.js"
if exist "%LOCAL_AGENT_INDEX%" goto :COPY_LOCAL
if not defined COORDINATOR_URL goto :NO_SOURCE

set "TGZ=%TEMP%\mindgit-agent.tar.gz"
set "DL_ATTEMPT=0"

:DL_RETRY
set /a DL_ATTEMPT+=1
if exist "%TGZ%" del /q "%TGZ%"
echo [INFO] Downloading agent package from %COORDINATOR_URL%/agent/download ^(poging %DL_ATTEMPT%^) ...
where curl >nul 2>nul
if %errorlevel% equ 0 goto :DL_CURL

REM Fallback for older Windows without curl.exe
powershell -NoProfile -ExecutionPolicy Bypass -Command "(New-Object System.Net.WebClient).DownloadFile('%COORDINATOR_URL%/agent/download','%TGZ%')"
goto :DL_VALIDATE

:DL_CURL
curl -fsSL "%COORDINATOR_URL%/agent/download" -o "%TGZ%"

:DL_VALIDATE
REM Validatie: een tar.gz begint met 0x1f 0x8b (gzip magic bytes). Een
REM foutpagina (bijv. 502 tijdens een server-herstart) is HTML en zou tar
REM laten crashen met "not in gzip format".
set "GZ_OK=false"
if not exist "%TGZ%" goto :DL_NOT_OK
powershell -NoProfile -ExecutionPolicy Bypass -Command "$b=[System.IO.File]::ReadAllBytes('%TGZ%'); if($b.Length -ge 2 -and $b[0] -eq 31 -and $b[1] -eq 139){exit 0}else{exit 1}"
if %errorlevel% equ 0 set "GZ_OK=true"

:DL_NOT_OK
if "%GZ_OK%"=="true" goto :EXTRACT
if %DL_ATTEMPT% lss 3 (
    echo [WARN] Download ongeldig - server was misschien aan het herstarten. Opnieuw proberen...
    timeout /t 2 /nobreak >nul 2>&1
    goto :DL_RETRY
)
echo [ERROR] Kon een geldig agent-pakket niet downloaden van %COORDINATOR_URL%.
echo Check dat de server draait en bereikbaar is: %COORDINATOR_URL%/agent/download
pause
exit /b 1

:EXTRACT
echo [OK] Downloaded (%TGZ%)
echo [INFO] Extracting agent package...
REM Forward-slashes so the built-in tar.exe treats the paths as local.
tar -xzf "%TGZ:\=/%" -C "%INSTALL_DIR:\=/%"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to extract the agent package. Windows 10 1803+ required.
    pause
    exit /b 1
)
del /q "%TGZ%" >nul 2>&1
echo [OK] Agent extracted
goto :HAVE_AGENT

:COPY_LOCAL
echo [INFO] Copying agent files from "%~dp0.."
xcopy /E /I /Y /Q "%~dp0..\*" "%INSTALL_DIR%\" >nul
if %errorlevel% neq 0 (
    echo [ERROR] Failed to copy files
    pause
    exit /b 1
)
goto :HAVE_AGENT

:NO_SOURCE
echo [ERROR] Local agent files not found next to this script and no coordinator URL given.
echo.
echo Either:
echo   - Run this script from the agent\scripts folder of the full project, or
echo   - Pass the URL of your MindGit server:
echo       install-windows.bat --coordinator=https://minddev.nl
pause
exit /b 1

:HAVE_AGENT

REM ---------------- Install npm dependencies ----------------
echo [INFO] Installing dependencies...
cd /d "%INSTALL_DIR%"
npm ci --production >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] npm ci failed, trying npm install...
    npm install --production >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
)
echo [OK] Dependencies installed

REM ---------------- Create .env template ----------------
if not exist "%INSTALL_DIR%\.env" (
    echo [INFO] Creating .env template...
    > "%INSTALL_DIR%\.env" echo # MindGit Agent Configuration
    >> "%INSTALL_DIR%\.env" echo # Get these values from the MindGit dashboard - Nodes ^> Add Node
    >> "%INSTALL_DIR%\.env" echo.
    if defined COORDINATOR_URL (
        >> "%INSTALL_DIR%\.env" echo COORDINATOR_URL=%COORDINATOR_URL%
    ) else (
        >> "%INSTALL_DIR%\.env" echo COORDINATOR_URL=https://minddev.nl
    )
    if defined NODE_KEY (
        >> "%INSTALL_DIR%\.env" echo NODE_KEY=%NODE_KEY%
    ) else (
        >> "%INSTALL_DIR%\.env" echo NODE_KEY=your-node-key-from-dashboard
    )
    >> "%INSTALL_DIR%\.env" echo.
    >> "%INSTALL_DIR%\.env" echo # Optional: Git timeouts
    >> "%INSTALL_DIR%\.env" echo GIT_TIMEOUT=15000
    >> "%INSTALL_DIR%\.env" echo GIT_LONG_TIMEOUT=30000
    >> "%INSTALL_DIR%\.env" echo.
    >> "%INSTALL_DIR%\.env" echo # Optional: Log level
    >> "%INSTALL_DIR%\.env" echo LOG_LEVEL=info
    echo [OK] .env template created at %INSTALL_DIR%\.env
)

REM ---------------- Read values from .env (for service config) ----------------
for /f "usebackq tokens=1,* delims==" %%a in ("%INSTALL_DIR%\.env") do (
    if /i "%%a"=="COORDINATOR_URL" if not defined COORDINATOR_URL set "COORDINATOR_URL=%%b"
    if /i "%%a"=="NODE_KEY" if not defined NODE_KEY set "NODE_KEY=%%b"
)

REM ---------------- Start helper for auto-start ----------------
REM The agent loads .env itself (agent/index.js), so this helper only needs
REM to run node from the install directory.
if not exist "%INSTALL_DIR%\start-agent.bat" (
    > "%INSTALL_DIR%\start-agent.bat" echo @echo off
    >> "%INSTALL_DIR%\start-agent.bat" echo cd /d "%%~dp0"
    >> "%INSTALL_DIR%\start-agent.bat" echo node index.js
)

REM ---------------- Choose installation type ----------------
echo.
echo [INFO] Choose installation type:
echo   1 - Windows Service - requires nssm, recommended for servers
echo   2 - Scheduled Task at logon - works everywhere
echo   3 - Manual start only
set /p CHOICE="Select [1-3]: "

if "%CHOICE%"=="1" goto :SERVICE_INSTALL
if "%CHOICE%"=="2" goto :SCHEDULED_TASK
goto :DONE

:SERVICE_INSTALL
where nssm >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] nssm not found. Download from https://nssm.cc/
    echo Falling back to Scheduled Task...
    goto :SCHEDULED_TASK
)
echo [INFO] Installing as Windows Service...
set "NODE_EXE="
where node > "%TEMP%\mindgit-node.txt" 2>nul
if exist "%TEMP%\mindgit-node.txt" set /p NODE_EXE=< "%TEMP%\mindgit-node.txt"
if exist "%TEMP%\mindgit-node.txt" del "%TEMP%\mindgit-node.txt" >nul 2>&1
if not defined NODE_EXE set "NODE_EXE=node"
nssm install MindGitAgent "%NODE_EXE%" "%INSTALL_DIR%\index.js" >nul 2>&1
nssm set MindGitAgent AppDirectory "%INSTALL_DIR%" >nul 2>&1
nssm set MindGitAgent AppEnvironmentExtra COORDINATOR_URL=%COORDINATOR_URL% NODE_KEY=%NODE_KEY% >nul 2>&1
nssm set MindGitAgent Start SERVICE_AUTO_START >nul 2>&1
nssm set MindGitAgent Description "MindGit Distributed Repository Sync Agent" >nul 2>&1
echo [OK] Service installed. Start with: net start MindGitAgent
goto :DONE

:SCHEDULED_TASK
echo [INFO] Creating scheduled task at logon...
schtasks /create /tn "MindGitAgent" /tr "\"%INSTALL_DIR%\start-agent.bat\"" /sc ONLOGON /rl HIGHEST /f >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Scheduled task created. Agent will start at next logon.
) else (
    echo [WARN] Could not create scheduled task - may need admin rights
)
goto :DONE

:DONE
echo.
echo   Installation Complete!
echo.
echo Next steps:
echo 1. Edit %INSTALL_DIR%\.env with your coordinator URL and node key
echo 2. Get the node key from the MindGit dashboard - Nodes ^> Add Node
echo 3. Start the agent:
if "%CHOICE%"=="1" echo    net start MindGitAgent
if "%CHOICE%"=="2" echo    will auto-start at logon - or run: "%INSTALL_DIR%\start-agent.bat"
if "%CHOICE%"=="3" echo    "%INSTALL_DIR%\start-agent.bat"
echo.
pause