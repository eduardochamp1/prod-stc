# tunel_banco.ps1: túnel SSH desta máquina até o Postgres da VM (P0-13).
# Porta local 15432 -> 127.0.0.1:5432 na VM. Reconecta sozinho se cair.
# Aberto pelo iniciar_coletor.ps1; dá para rodar sozinho também.

$vm = 'usr_jose@172.25.3.154'
$portaLocal = 15432
while ($true) {
    Write-Host ""
    Write-Host "$(Get-Date -Format 'HH:mm:ss') Abrindo o túnel do banco para $vm (127.0.0.1:$portaLocal)." -ForegroundColor Cyan
    Write-Host "Se ficar parado sem mensagem, está funcionando. Deixe esta janela aberta." -ForegroundColor Cyan
    ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes `
        -L "127.0.0.1:${portaLocal}:127.0.0.1:5432" $vm
    Write-Host "$(Get-Date -Format 'HH:mm:ss') O túnel caiu (código $LASTEXITCODE). Nova tentativa em 15 s; Ctrl+C encerra." -ForegroundColor Yellow
    Write-Host "Se cair na hora toda vez, rode à parte para ver o motivo: ssh -v -N -L 127.0.0.1:${portaLocal}:127.0.0.1:5432 $vm" -ForegroundColor DarkGray
    Start-Sleep -Seconds 15
}
