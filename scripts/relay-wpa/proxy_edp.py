#!/usr/bin/env python3
"""
proxy_edp.py: proxy HTTPS mínimo (método CONNECT) que só deixa passar
conexões para os hosts da EDP listados em PERMITIDOS.

Roda numa máquina cuja saída para a internet a EDP aceita (rede da Engelmig,
ou um computador com a VPN conectada) e é exposto à VM por um túnel SSH
reverso (ssh -R). Escuta apenas em 127.0.0.1, então não fica acessível pela
rede local. Só usa a biblioteca padrão do Python (3.8 ou superior).

Uso: python proxy_edp.py
"""
import asyncio
import datetime

PORTA = 3128

# Hosts que a aplicação chama na EDP, em minúsculas e sem https://
# Inclua também o host de autenticação, se for diferente do da API.
PERMITIDOS = {
    "edp-wpa-web-api.azurewebsites.net",   # API de dados
    "edp-wpa-po.azurewebsites.net",        # login (/identity/signin)
}


def log(msg):
    print(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


async def bombear(origem, destino):
    """Copia bytes de um lado do túnel para o outro até alguém fechar."""
    try:
        while dados := await origem.read(65536):
            destino.write(dados)
            await destino.drain()
    except OSError:
        pass
    finally:
        destino.close()


async def atender(cliente_r, cliente_w):
    try:
        linha = (await cliente_r.readline()).decode("latin-1").strip()
        metodo, alvo, _ = linha.split(" ", 2)
        while (await cliente_r.readline()) not in (b"\r\n", b"\n", b""):
            pass  # descarta os cabeçalhos da requisição CONNECT

        host, _, porta = alvo.rpartition(":")
        host = host.lower()
        if metodo.upper() != "CONNECT" or porta != "443" or host not in PERMITIDOS:
            log(f"RECUSADO {metodo} {alvo}")
            cliente_w.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            await cliente_w.drain()
            cliente_w.close()
            return

        try:
            remoto_r, remoto_w = await asyncio.wait_for(
                asyncio.open_connection(host, 443), timeout=15)
        except (OSError, asyncio.TimeoutError) as erro:
            # esta máquina não alcança a EDP (VPN caída, DNS, rede)
            log(f"SEM ROTA {host}: {type(erro).__name__}: {erro}")
            cliente_w.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            await cliente_w.drain()
            cliente_w.close()
            return
        cliente_w.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await cliente_w.drain()
        log(f"OK {host}")
        await asyncio.gather(bombear(cliente_r, remoto_w),
                             bombear(remoto_r, cliente_w))
    except Exception as erro:
        log(f"ERRO {type(erro).__name__}: {erro}")
        cliente_w.close()


async def main():
    servidor = await asyncio.start_server(atender, "127.0.0.1", PORTA)
    log(f"proxy em 127.0.0.1:{PORTA}, liberado para: {', '.join(sorted(PERMITIDOS))}")
    async with servidor:
        await servidor.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
