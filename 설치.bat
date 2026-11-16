@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  쪽지보관함 설치를 시작합니다...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 (
  echo.
  echo  [실패] 설치 중 오류가 났습니다. 위 메시지를 확인하세요.
  echo  Node.js 22.13 이상이 설치되어 있는지, config.json의 메신저 경로가 맞는지 확인하세요.
) else (
  echo.
  echo  [완료] 바탕화면의 'saveMyGenmessage' 아이콘으로 열 수 있습니다.
)
echo.
pause
