# proxy_edp.ps1: mesma coisa que o proxy_edp.py, para desktop Windows SEM Python.
# Proxy HTTPS minimo (metodo CONNECT) que so deixa passar conexoes para os hosts
# da EDP em $Permitidos. Escuta so em 127.0.0.1; chega na VM por tunel SSH
# reverso (ssh -R). Roda no Windows PowerShell 5.1 que ja vem no Windows.
#
# 24/10/2026: criado porque o desktop do relay nao tinha Python ("py nao e
# reconhecido"). So ASCII neste arquivo: o PowerShell 5.1 le .ps1 sem BOM como ANSI.
#
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File proxy_edp.ps1
# Parar: Ctrl+C

$Porta = 3128
$Permitidos = @(
    'edp-wpa-po.azurewebsites.net',       # login (WPA_URL)
    'edp-wpa-web-api.azurewebsites.net'   # Web API (WPA_API_URL)
)

function Log($msg) { Write-Host ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg) }

function Enviar($stream, $texto) {
    $b = [System.Text.Encoding]::ASCII.GetBytes($texto)
    $stream.Write($b, 0, $b.Length)
}

# Pares de conexao em uso; fechados quando um dos lados termina.
$ativos = New-Object System.Collections.ArrayList

function Limpar {
    foreach ($a in @($ativos)) {
        if ($a.ida.IsCompleted -or $a.volta.IsCompleted) {
            $a.cliente.Close(); $a.remoto.Close()
            $ativos.Remove($a)
        }
    }
}

function Atender($cliente) {
    $s = $cliente.GetStream()
    $s.ReadTimeout = 5000

    # Le o cabecalho byte a byte ate a linha em branco, sem consumir nada alem dele.
    $um = New-Object byte[] 1
    $sb = New-Object System.Text.StringBuilder
    while (-not $sb.ToString().EndsWith("`r`n`r`n")) {
        if ($s.Read($um, 0, 1) -le 0) { throw 'cliente fechou antes do cabecalho' }
        [void]$sb.Append([char]$um[0])
        if ($sb.Length -gt 8192) { throw 'cabecalho grande demais' }
    }
    $linha = ($sb.ToString() -split "`r`n")[0]
    $partes = $linha -split ' '
    $metodo = $partes[0]
    $alvo = $partes[1]
    $i = $alvo.LastIndexOf(':')
    $hostAlvo = if ($i -gt 0) { $alvo.Substring(0, $i).ToLower() } else { '' }
    $portaAlvo = if ($i -gt 0) { $alvo.Substring($i + 1) } else { '' }

    if ($metodo -ne 'CONNECT' -or $portaAlvo -ne '443' -or $Permitidos -notcontains $hostAlvo) {
        Log "RECUSADO $metodo $alvo"
        Enviar $s "HTTP/1.1 403 Forbidden`r`n`r`n"
        $cliente.Close()
        return
    }

    $remoto = New-Object System.Net.Sockets.TcpClient
    try {
        if (-not $remoto.ConnectAsync($hostAlvo, 443).Wait(15000)) { throw "sem conexao em 15s" }
    } catch {
        # Esta maquina nao alcanca a EDP (VPN caida, DNS, rede): 502, como o proxy_edp.py.
        # Na VM vira WPA_PROXY_SEM_ROTA, diferente de proxy parado (INDISPONIVEL).
        $remoto.Close()
        Log "SEM ROTA $hostAlvo : $($_.Exception.GetBaseException().Message)"
        Enviar $s "HTTP/1.1 502 Bad Gateway`r`n`r`n"
        $cliente.Close()
        return
    }
    Enviar $s "HTTP/1.1 200 Connection Established`r`n`r`n"
    $s.ReadTimeout = -1
    $r = $remoto.GetStream()
    [void]$ativos.Add(@{ cliente = $cliente; remoto = $remoto; ida = $s.CopyToAsync($r); volta = $r.CopyToAsync($s) })
    Log "OK $hostAlvo"
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Porta)
$listener.Start()
Log "proxy em 127.0.0.1:$Porta, liberado para: $($Permitidos -join ', ')"
try {
    $aceite = $listener.AcceptTcpClientAsync()
    while ($true) {
        # Espera em fatias de 1 s: deixa o Ctrl+C funcionar e limpa conexoes encerradas.
        if ($aceite.Wait(1000)) {
            $cliente = $aceite.Result
            $aceite = $listener.AcceptTcpClientAsync()
            try { Atender $cliente } catch {
                Log "ERRO $($_.Exception.GetBaseException().Message)"
                $cliente.Close()
            }
        }
        Limpar
    }
} finally {
    $listener.Stop()
}
