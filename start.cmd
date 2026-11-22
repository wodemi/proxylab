@echo off
chcp 65001 >nul
title 代理测速台
cd /d "%~dp0"

rem 正常用法是双击桌面「代理测速台」图标。
rem 这个 cmd 是给想看到日志 / 排查问题的人用的：服务在前台跑，报错直接打在窗口里。

echo.
echo   代理测速台 · 前台模式
echo   ----------------------------------------
echo   服务地址 http://127.0.0.1:8787
echo   窗口开着服务就开着，关掉窗口服务就停。
echo.

set NODE="C:\Program Files\nodejs\node.exe"
if not exist %NODE% set NODE=node

rem 等服务起来后，用 launch.vbs 打开应用窗口（它检测到服务已在，不会重复启动）
start "" /b cmd /c "timeout /t 3 >nul & wscript.exe ""%~dp0launch.vbs"""

%NODE% server.mjs
pause
