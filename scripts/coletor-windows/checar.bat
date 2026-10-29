@echo off
rem Confere banco (pelo túnel) e EDP, sem coletar. O túnel precisa estar aberto.
cd /d "%~dp0"
node\node.exe coletor.js --checar
pause
