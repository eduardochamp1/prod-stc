@echo off
rem Instala o relay WPA automatico (P0-14): sobe sozinho a cada logon. Duplo clique, uma vez.
rem Precisa do instalar_auto.ps1, relay_auto.ps1 e proxy_edp.ps1 na mesma pasta.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar_auto.ps1"
pause
