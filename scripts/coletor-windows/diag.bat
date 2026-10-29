@echo off
rem Diagnóstico: UMA consulta de sessões na EDP e a resposta crua. O túnel precisa estar aberto.
rem Uso: diag.bat [SETOR] [AAAA-MM-DD]   (padrão: DESG, ontem)
cd /d "%~dp0"
node\node.exe coletor.js --diag %1 %2
pause
