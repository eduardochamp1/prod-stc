@echo off
rem Liga o relay WPA (P0-9): proxy + tunel SSH ate a VM. Duplo clique.
rem Precisa do iniciar_relay.ps1 e do proxy_edp.ps1 na mesma pasta.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar_relay.ps1"
pause
