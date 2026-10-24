# iniciar_relay.ps1: sobe o relay WPA no desktop (proxy + túnel SSH até a VM).
# Requisitos: VPN corporativa conectada e o proxy_edp.ps1 na mesma pasta.
# Não precisa de Python: usa o proxy em PowerShell (24/10/2026, o desktop do
# relay não tinha Python). Com Python instalado, o proxy_edp.py faz o mesmo.
# Uso: botão direito > "Executar com o PowerShell", ou
#      powershell -ExecutionPolicy Bypass -File .\iniciar_relay.ps1

$ErrorActionPreference = 'Continue'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$proxy = Join-Path $pasta 'proxy_edp.ps1'
$vm    = 'usr_jose@172.25.3.154'
$porta = 3128

if (-not (Test-Path $proxy)) {
    Write-Host "Não encontrei $proxy. Coloque o proxy_edp.ps1 na mesma pasta deste script." -ForegroundColor Red
    Write-Host "Para baixar da VM: scp ${vm}:prod-stc/scripts/relay-wpa/proxy_edp.ps1 `"$pasta`"" -ForegroundColor DarkGray
    Read-Host 'Enter para sair'; exit 1
}

# 1. Proxy em uma janela própria (se ainda não estiver rodando)
$escutando = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $porta -State Listen -ErrorAction SilentlyContinue
if ($escutando) {
    Write-Host "Proxy já está escutando em 127.0.0.1:$porta." -ForegroundColor Yellow
} else {
    Start-Process -FilePath 'powershell.exe' -WorkingDirectory $pasta `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$proxy`""
    Start-Sleep -Seconds 2
    Write-Host "Proxy iniciado em outra janela (deixe-a aberta)." -ForegroundColor Green
}

# 2. Daqui, a API da EDP precisa responder 200 (sinal de que a VPN está ok)
$codigo = & curl.exe -s -o NUL -w "%{http_code}" --max-time 15 https://edp-wpa-web-api.azurewebsites.net/
if ($codigo -eq '200') {
    Write-Host "API da EDP acessível a partir deste computador (200)." -ForegroundColor Green
} else {
    Write-Host "A API da EDP respondeu '$codigo' daqui. Confira a VPN antes de seguir." -ForegroundColor Red
}

# 3. Túnel SSH com reconexão automática
while ($true) {
    Write-Host ""
    Write-Host "$(Get-Date -Format 'HH:mm:ss') Abrindo o túnel para $vm." -ForegroundColor Cyan
    Write-Host "Se ficar parado sem mensagem, está funcionando. Deixe esta janela aberta." -ForegroundColor Cyan
    ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes `
        -R "localhost:${porta}:127.0.0.1:${porta}" $vm
    Write-Host "$(Get-Date -Format 'HH:mm:ss') O túnel caiu (código $LASTEXITCODE). Nova tentativa em 15 s; Ctrl+C encerra." -ForegroundColor Yellow
    Write-Host "Se cair na hora toda vez, rode à parte para ver o motivo: ssh -v -N -R localhost:${porta}:127.0.0.1:${porta} $vm" -ForegroundColor DarkGray
    Start-Sleep -Seconds 15
}
