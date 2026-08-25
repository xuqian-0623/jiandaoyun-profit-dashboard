@echo off
chcp 65001 >nul
title 简道云利润看板 - 临时分享
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-TemporaryShare.ps1"
if errorlevel 1 pause
