@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  자동 수집과 바탕화면 아이콘을 제거하고, 실행 중인 보관함 서버를 끕니다. (보관된 쪽지는 지우지 않습니다)
echo.
choice /c YN /m " 계속할까요"
if errorlevel 2 goto :end
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
:end
echo.
pause
