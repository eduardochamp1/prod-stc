# relay_auto.ps1: o relay WPA (P0-9) sem janela e sem clique. Sobe o proxy
# (proxy_edp.ps1) e mantem o tunel SSH reverso ate a VM, reconectando sozinho.
# Feito para rodar escondido no logon do Windows (instalar_auto.ps1 cria o atalho).
#
# 09/11/2026 (P0-14), pedido do Jose: "como podemos automatizar a conexao, sem
# depender de eu abrir o ralay". O iniciar_relay.ps1 continua valendo para uso
# manual, com janela; este aqui e o mesmo relay, so que:
#   - usa SO a chave ~/.ssh/relay_wpa (sem senha; -F none e sem agente, para nao
#     entrar por outra chave do PC) e BatchMode: nunca pergunta nada;
#   - nao abre janela; o que acontece fica em relay.log, nesta pasta;
#   - so uma copia roda por vez (mutex).
# Continua precisando do PC ligado e da VPN conectada: sem VPN ele fica
# tentando a cada 30 s e o tunel sobe sozinho quando ela conectar.
#
# So ASCII neste arquivo: o PowerShell 5.1 le .ps1 sem BOM como ANSI.

$ErrorActionPreference = 'Continue'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$proxy = Join-Path $pasta 'proxy_edp.ps1'
$logArq = Join-Path $pasta 'relay.log'
$chave = Join-Path $HOME '.ssh\relay_wpa'
$vm    = 'usr_jose@172.25.3.154'
$porta = 3128
$esperaS = 30

function Log($msg) {
    $linha = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg
    try {
        if ((Test-Path $logArq) -and ((Get-Item $logArq).Length -gt 1MB)) {
            Move-Item -Force $logArq ($logArq + '.1')
        }
        Add-Content -Path $logArq -Value $linha -Encoding ASCII
    } catch { }
}

# Uma copia so.
$criado = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\RelayWpaAuto', [ref]$criado)
if (-not $criado) { exit 0 }

if (-not (Test-Path $proxy)) { Log "FALTA $proxy - relay nao iniciado"; exit 1 }
if (-not (Test-Path $chave)) { Log "FALTA a chave $chave - rode o instalar_auto.ps1"; exit 1 }

Log "relay_auto iniciado (pasta $pasta)"
$ultimoEstado = ''

while ($true) {
    # 1. Proxy local: sobe se ninguem estiver escutando na porta.
    $escutando = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $porta -State Listen -ErrorAction SilentlyContinue
    if (-not $escutando) {
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $pasta `
            -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$proxy`""
        Start-Sleep -Seconds 2
        Log "proxy iniciado em 127.0.0.1:$porta"
    }

    # 2. Tunel. Fica preso aqui enquanto o tunel estiver de pe.
    $t0 = Get-Date
    & ssh.exe -F none -N -i $chave -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o ConnectTimeout=15 `
        -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes `
        -R "localhost:${porta}:127.0.0.1:${porta}" $vm 2>$null
    $codigo = $LASTEXITCODE
    $durou = [int]((Get-Date) - $t0).TotalSeconds

    # Log sem repetir a mesma linha a cada 30 s quando a VPN esta desligada.
    if ($durou -ge 60) {
        Log "tunel caiu depois de $durou s (codigo $codigo); reconectando"
        $ultimoEstado = ''
    } else {
        $estado = "sem tunel (codigo $codigo): VPN desligada, VM fora ou porta $porta ocupada na VM por outro relay"
        if ($estado -ne $ultimoEstado) { Log "$estado; tentando a cada $esperaS s"; $ultimoEstado = $estado }
    }
    Start-Sleep -Seconds $esperaS
}
