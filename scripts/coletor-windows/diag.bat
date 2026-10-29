@echo off
rem Diagnóstico: 3 consultas na EDP (V2, sessões de hoje e da data) e a resposta crua. O túnel precisa estar aberto.
rem Uso: diag.bat [SETOR] [AAAA-MM-DD]   (padrão: DESG, ontem)
cd /d "%~dp0"
node\node.exe coletor.js --diag %1 %2
pause
