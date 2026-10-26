@echo off
REM ============================================================
REM  sync.bat — 从 GitHub 同步最新报告到本地
REM
REM  不写死路径：自动定位到本脚本所在目录，项目可随意改名/搬家
REM  由 Windows 计划任务调用（登录时 + 每日 09:05）
REM ============================================================

REM %~dp0 是本 bat 文件所在目录（含末尾反斜杠）
cd /d "%~dp0"

REM 确保日志目录存在
if not exist "logs" mkdir "logs"

set LOGFILE=logs\sync.log

if not exist ".git" (
    echo [%date% %time%] 尚未初始化 git 仓库，跳过同步>> "%LOGFILE%"
    exit /b 0
)

REM 记录当前分支
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set BRANCH=%%b
if "%BRANCH%"=="" set BRANCH=main

echo. >> "%LOGFILE%"
echo [%date% %time%] 开始同步 分支=%BRANCH% 目录=%CD%>> "%LOGFILE%"

git pull --rebase --autostash origin %BRANCH% >> "%LOGFILE%" 2>&1

if %errorlevel%==0 (
    echo [%date% %time%] 同步成功>> "%LOGFILE%"
) else (
    echo [%date% %time%] 同步失败，请检查网络或冲突>> "%LOGFILE%"
)
