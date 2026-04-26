@echo off
echo.
echo  WPA Monitor — Engelmig Energia
echo  Iniciando backend...
echo.
cd /d "%~dp0backend"
npm install
npm run dev
