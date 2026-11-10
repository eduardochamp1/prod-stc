# instalar_auto.ps1: instala o relay WPA automatico neste computador (uma vez).
# Depois disso o relay sobe sozinho, escondido, a cada logon do Windows.
# Nao precisa de administrador.
#
# 09/11/2026 (P0-14). O que este script faz:
#   1. cria a chave SSH ~/.ssh/relay_wpa (sem senha), se ainda nao existir;
#   2. cadastra a chave na VM COM RESTRICAO: ela so abre a porta 3128 em
#      localhost e nao executa comando nenhum (manual, secao 9.7.2). Pede a
#      senha da VM uma unica vez;
#   3. cria um atalho na pasta Inicializar do seu usuario para o relay_auto.ps1;
#   4. liga o relay agora.
#
# Uso:      powershell -ExecutionPolicy Bypass -File .\instalar_auto.ps1
# Desfazer: powershell -ExecutionPolicy Bypass -File .\instalar_auto.ps1 -Remover
#
# So ASCII neste arquivo: o PowerShell 5.1 le .ps1 sem BOM como ANSI.

param([switch]$Remover)

$ErrorActionPreference = 'Continue'
$pasta  = Split-Path -Parent $MyInvocation.MyCommand.Path
$auto   = Join-Path $pasta 'relay_auto.ps1'
$proxy  = Join-Path $pasta 'proxy_edp.ps1'
$chave  = Join-Path $HOME '.ssh\relay_wpa'
$vm     = 'usr_jose@172.25.3.154'
$atalho = Join-Path ([Environment]::GetFolderPath('Startup')) 'Relay WPA.lnk'

function PararRelay {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*relay_auto.ps1*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*relay_wpa*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Remover) {
    if (Test-Path $atalho) { Remove-Item $atalho -Force; Write-Host "Atalho removido: $atalho" -ForegroundColor Green }
    PararRelay
    Write-Host "Relay automatico parado. O proxy (se ainda estiver aberto) fecha no proximo logon." -ForegroundColor Green
    Write-Host "A chave continua cadastrada na VM. Para revogar, apague na VM a linha 'relay-wpa-auto' do ~/.ssh/authorized_keys." -ForegroundColor DarkGray
    exit 0
}

foreach ($f in @($auto, $proxy)) {
    if (-not (Test-Path $f)) {
        Write-Host "Nao encontrei $f. Os arquivos relay_auto.ps1 e proxy_edp.ps1 precisam estar nesta pasta." -ForegroundColor Red
        exit 1
    }
}

# 1. Chave dedicada, sem senha (a restricao na VM e o que protege).
if (-not (Test-Path $chave)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $HOME '.ssh') | Out-Null
    & ssh-keygen.exe -q -t ed25519 -f $chave -N '""' -C relay-wpa-auto
    if (-not (Test-Path $chave)) { Write-Host "Nao consegui criar a chave em $chave." -ForegroundColor Red; exit 1 }
    Write-Host "Chave criada: $chave" -ForegroundColor Green
} else {
    Write-Host "Chave ja existe: $chave" -ForegroundColor Yellow
}

# 2. Cadastra a chave na VM, sem duplicar (o grep na VM decide).
#    09/11/2026: a 1a versao testava antes com "ssh ... exit" e TRAVOU na maquina
#    do Jose logo depois de "Chave criada": o ssh autenticou (por outra chave que
#    o PC ja tinha), o comando terminou na VM e o ssh do Windows nao voltou. Sem
#    teste previo agora; quem prova que funcionou e o tunel de pe no passo 4.
Write-Host ""
Write-Host "Cadastrando a chave na VM. Se pedir senha, e a da VM (nao aparece enquanto digita)." -ForegroundColor Cyan
Write-Host "Se der erro de conexao, confira a VPN e rode de novo." -ForegroundColor DarkGray
$pub = (Get-Content ($chave + '.pub') -Raw).Trim()
$blob = $pub.Split(' ')[1]
$linha = 'restrict,port-forwarding,permitlisten="localhost:3128",command="/bin/false" ' + $pub
$f = '~/.ssh/authorized_keys'
$remoto = "umask 077; mkdir -p ~/.ssh; touch $f; grep -qF $blob $f || (tail -c1 $f | grep -q . && echo >> $f; tr -d \\r >> $f)"
$linha | & ssh.exe -o ConnectTimeout=15 $vm $remoto
if ($LASTEXITCODE -ne 0) {
    Write-Host "Nao consegui cadastrar a chave na VM (codigo $LASTEXITCODE). Nada foi instalado. Confira a VPN/senha e rode de novo." -ForegroundColor Red
    exit 1
}
Write-Host "Chave cadastrada na VM (so abre a porta 3128, sem shell)." -ForegroundColor Green

# 3. Atalho na pasta Inicializar do usuario (nao precisa de administrador).
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($atalho)
$lnk.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$auto`""
$lnk.WorkingDirectory = $pasta
$lnk.WindowStyle = 7
$lnk.Description = 'Relay WPA (proxy + tunel ate a VM) - P0-14'
$lnk.Save()
Write-Host "Atalho criado: $atalho" -ForegroundColor Green

# 4. Liga agora.
PararRelay
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $pasta `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$auto`""
Start-Sleep -Seconds 12
Write-Host ""
$tunel = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*relay_wpa*' }
if ($tunel) {
    Write-Host "Relay automatico ligado: o tunel esta de pe." -ForegroundColor Green
} else {
    Write-Host "O relay foi ligado, mas o tunel ainda NAO subiu (veja o log abaixo)." -ForegroundColor Red
}
Write-Host "Ultimas linhas do log ($pasta\relay.log):" -ForegroundColor DarkGray
Get-Content (Join-Path $pasta 'relay.log') -Tail 5 -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "IMPORTANTE: feche as janelas do relay manual (iniciar_relay), se estiverem abertas." -ForegroundColor Yellow
Write-Host "Enquanto elas ocuparem a porta 3128 da VM, o automatico fica so tentando." -ForegroundColor Yellow
Write-Host "Daqui em diante: ligar o PC e conectar a VPN. O tunel sobe sozinho." -ForegroundColor Cyan
