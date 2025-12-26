@echo off
REM Kill all node.exe processes before starting dev server
echo 🔍 Cleaning up Node.js processes...
taskkill /F /IM node.exe >nul 2>&1
if %errorlevel%==0 (
    echo ✅ Killed Node.js processes
) else (
    echo ✅ No Node.js processes to kill
)
echo ✅ Ready to start!
