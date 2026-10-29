# iniciar_coletor.ps1: liga o coletor da EDP nesta máquina (P0-13, 29/10/2026).
# 1. confere se a EDP responde daqui (rede da Engelmig / VPN);
# 2. abre o túnel SSH para o banco da VM (porta local 15432 -> Postgres da VM)
#    numa janela própria, com reconexão automática;
# 3. roda o coletor (node\node.exe coletor.js), que se reinicia sozinho se cair.
# Uso: duplo clique no iniciar.bat. Deixe as DUAS janelas abertas.

$ErrorActionPreference = 'Continue'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$node  = Join-Path $pasta 'node\node.exe'
$env_  = Join-Path $pasta 'coletor.env'
$tunel = Join-Path $pasta 'tunel_banco.ps1'
$portaLocal = 15432

if (-not (Test-Path $node)) { Write-Host "Não encontrei $node. O pacote está incompleto." -ForegroundColor Red; Read-Host 'Enter para sair'; exit 1 }
if (-not (Test-Path $env_)) {
    Write-Host "Não encontrei $env_." -ForegroundColor Red
    Write-Host "Copie coletor.env.exemplo para coletor.env e preencha (ou peça o coletor.env pronto, gerado na VM)." -ForegroundColor DarkGray
    Read-Host 'Enter para sair'; exit 1
}

# 1. A EDP precisa responder daqui (sinal de que a rede/VPN está ok)
$codigo = & curl.exe -s -o NUL -w "%{http_code}" --max-time 15 https://edp-wpa-web-api.azurewebsites.net/
if ($codigo -eq '200') {
    Write-Host "API da EDP acessível a partir deste computador (200)." -ForegroundColor Green
} else {
    Write-Host "A API da EDP respondeu '$codigo' daqui. Confira a VPN. O coletor liga mesmo assim e as coletas vão falhar até a rede voltar." -ForegroundColor Red
}

# 2. Túnel para o banco, em outra janela (se ainda não estiver aberto)
$aberto = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $portaLocal -State Listen -ErrorAction SilentlyContinue
if ($aberto) {
    Write-Host "Túnel do banco já está aberto em 127.0.0.1:$portaLocal." -ForegroundColor Yellow
} else {
    Start-Process -FilePath 'powershell.exe' -WorkingDirectory $pasta `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$tunel`""
    Write-Host "Abrindo o túnel do banco em outra janela (deixe-a aberta)..." -ForegroundColor Cyan
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $portaLocal -State Listen -ErrorAction SilentlyContinue) { break }
    }
    if (-not (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $portaLocal -State Listen -ErrorAction SilentlyContinue)) {
        Write-Host "O túnel não abriu em 60 s. Veja a janela do túnel (senha/chave SSH?)." -ForegroundColor Red
    } else {
        Write-Host "Túnel do banco aberto." -ForegroundColor Green
    }
}

# 3. Coletor, com reinício automático
Set-Location $pasta
while ($true) {
    Write-Host ""
    Write-Host "$(Get-Date -Format 'HH:mm:ss') Ligando o coletor. Deixe esta janela aberta; Ctrl+C encerra." -ForegroundColor Cyan
    & $node coletor.js
    Write-Host "$(Get-Date -Format 'HH:mm:ss') O coletor parou (código $LASTEXITCODE). Religando em 30 s." -ForegroundColor Yellow
    Start-Sleep -Seconds 30
}
