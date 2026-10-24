# Manual de restabelecimento do acesso à API WPA da EDP

**Sistema:** WPA Monitor e coletas associadas
**Versão:** 1.2 (24/10/2026, conferida com o código do repo `prod-stc`; proxy com 502, relay em PowerShell e códigos de erro)
**Responsável:** José, Analista de Desempenho, Engelmig Energia

---

## Sumário

1. Objetivo
2. Resumo executivo
3. Contexto
4. Diagnóstico complementar
5. Alternativas avaliadas
6. Plano recomendado
7. Método A: nova liberação de IP pela EDP
8. Método B: saída pela rede da Engelmig, configurada pela TI
9. Método C: relay de saída (proxy restrito e túnel SSH reverso)
10. Método D: coleta executada no servidor interno
11. Método E: cliente de VPN na VM (não recomendado)
12. Solução de problemas
13. Governança e segurança
14. Checklist final

Anexo A: código do `proxy_edp.py`
Anexo B: referência rápida de comandos

---

## 1. Objetivo

Registrar a causa da interrupção do acesso do WPA Monitor à API WPA da EDP e os métodos para restabelecê-lo, do paliativo imediato à solução definitiva. Cada método traz os passos de execução, a forma de validar e, quando se aplica, como desfazer.

---

## 2. Resumo executivo

- **O que aconteceu:** a API WPA da EDP passou a recusar as requisições vindas da VM na Oracle Cloud onde o WPA Monitor roda. Pelo desktop, com a VPN corporativa conectada, o acesso funciona normalmente.
- **Causa provável:** a API trabalha com uma lista de IPs autorizados. O IP de saída da VM (144.22.240.169) não está, ou deixou de estar, nessa lista. O IP de saída da rede corporativa continua autorizado.
- **Solução imediata:** fazer as chamadas à EDP saírem por uma máquina da rede da Engelmig, usando um proxy restrito aos hosts da EDP e um túnel SSH reverso até a VM (Método C). Não exige sudo nem VPN na VM.
- **Solução definitiva:** obter da EDP a liberação de um IP fixo da VM (Método A) ou pedir à TI que a saída da VM para a EDP passe pela rede da Engelmig (Método B).
- **Não recomendado:** instalar cliente de VPN na VM (Método E). Ele depende de autenticação manual com MFA, cai periodicamente e expõe a rede interna à VM.

---

## 3. Contexto

### 3.1 Componentes envolvidos

| Componente | Onde roda | Papel |
|---|---|---|
| VM Oracle Cloud | IP privado 172.25.3.154, Ubuntu 24.04 (x86_64), usuário `usr_jose` sem sudo | Hospeda as aplicações |
| WPA Monitor (este repo) | VM, Node.js + Express + Postgres local (via `services/pgShim.js`), porta 3002, PM2 `wpa-monitor` | Monitoramento operacional a partir dos dados do WPA |
| Serviço API WPA (somente leitura) | VM, porta 3003 | Disponibiliza os dados coletados |
| Aplicação gseq | VM, Next.js | Interface web |
| Scripts de ETL (fora deste repo) | Python (`import_wpa_es.py`, `monitor_stc_es.py`) | Coleta na API WPA e carga no PostgreSQL |
| API WPA da EDP | Azure, sob gestão da EDP | Origem dos dados: autenticação JWT, CompanyId fixo da Engelmig e lista de IPs autorizados |
| Servidor interno da Engelmig | Rede da Engelmig | Obtém o token da API e o injeta na VM (para os sistemas que dependem disso; o WPA Monitor faz o próprio login em `services/wpaService.js`) |

### 3.2 O que mudou

A lista de IPs autorizados da API já existia: por isso o token era obtido por um servidor interno da Engelmig e injetado na VM. Agora a EDP também recusa as chamadas de dados feitas a partir da VM.

O WPA Monitor fala com dois hosts da EDP, ambos no Azure App Service:

| Variável no `.env` | Host | Uso |
|---|---|---|
| `WPA_URL` | `edp-wpa-po.azurewebsites.net` | Login (`/identity/signin`) |
| `WPA_API_URL` | `edp-wpa-web-api.azurewebsites.net` | Web API (sessões, equipes, notas) | As mesmas chamadas, feitas de um computador conectado à VPN corporativa, continuam funcionando.

### 3.3 Fatos levantados em 23/10/2026

| Verificação | Resultado | Implicação |
|---|---|---|
| IP público de saída da VM (`curl https://ifconfig.me`) | 144.22.240.169, faixa da Oracle | É o IP que a EDP enxerga hoje |
| Sistema da VM | Ubuntu 24.04.4 LTS, x86_64 | Pacotes e binários para amd64 |
| Privilégios na VM | Sem sudo | Nenhuma solução pode exigir root na VM |
| Túneis no servidor SSH da VM | `AllowTcpForwarding` no padrão, ou seja, permitido | O túnel reverso do Método C é viável |
| openconnect e ocproxy | Não instalados | O Método E exigiria instalação no diretório do usuário |
| Acesso à VM | Termius, pelo IP privado 172.25.3.154 | Indica conectividade privada entre a rede da Engelmig e a rede da VM na OCI |
| Estado da VM | Reinicialização pendente | A solução precisa voltar sozinha depois de um reboot |

### 3.4 Causa provável

Bloqueio por lista de IPs na API da EDP. Há duas hipóteses, e o diagnóstico da seção 4 separa uma da outra:

1. **O IP da VM mudou** e a EDP continua autorizando o IP antigo. Na OCI isso acontece quando a VM usa IP público efêmero e a instância ou a rede é recriada, ou quando o NAT gateway da subrede é substituído.
2. **A EDP removeu o IP de propósito**, por revisão da lista ou por mudança de política (por exemplo, deixar de aceitar IPs de provedores de nuvem).

**Atenção à hipótese 2.** Em 19/10/2026 a EDP questionou "diversas requisições" congestionando a WPA (backlog P0-11), poucos dias antes do bloqueio. Se o IP foi retirado por causa do volume, sair pelo IP corporativo (Métodos B e C) contorna uma decisão da EDP, num contrato que ela audita. Nesse caso, fale com a EDP antes ou junto com o Método C, levando os números do contador (`GET /api/admin/wpa-requisicoes`) e as reduções do P0-11.

---

## 4. Diagnóstico complementar

Execute antes de escolher o método definitivo. Leva poucos minutos e muda o encaminhamento.

### 4.1 Comparar o IP autorizado com o IP atual

Localize o e-mail ou chamado em que a liberação foi pedida à EDP e compare o IP registrado com **144.22.240.169**.

- **IP diferente:** o IP da VM mudou. O caminho natural é o Método A, começando por um IP reservado.
- **IP igual:** a EDP removeu a autorização. O Método A passa a depender de entender o motivo, e o Método B ganha peso.

### 4.2 Identificar o IP que a EDP aceita

No desktop, com a VPN conectada, abra `https://ifconfig.me` no navegador. Esse é o IP de saída da rede corporativa, que a EDP aceita. Anote: ele serve de referência para os pedidos e para validar os métodos B e C.

### 4.3 Identificar como o bloqueio acontece

Na VM, sem proxy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 https://edp-wpa-web-api.azurewebsites.net/
```

| Resultado | Interpretação |
|---|---|
| `403` | A requisição chega à EDP e é recusada pelo gateway da API: bloqueio por IP |
| `000` | A conexão é descartada antes (timeout): bloqueio em firewall de rede |
| `401` ou `404` | A camada de rede aceitou a conexão; investigue autenticação ou URL antes de concluir que há bloqueio por IP |

### 4.4 Levantar os hosts que a aplicação chama

No WPA Monitor já estão levantados (seção 3.2): `edp-wpa-po.azurewebsites.net` e `edp-wpa-web-api.azurewebsites.net`. Confira no `.env` da VM se `WPA_URL` e `WPA_API_URL` ainda apontam para eles:

```bash
grep -E "^WPA_(URL|API_URL)=" ~/prod-stc/.env
```

Para os scripts de ETL, que ficam fora deste repo, levante os hosts no código e no arquivo que inicia cada processo. Todos os hosts da EDP entram no proxy do Método C e no pedido do Método B.

---

## 5. Alternativas avaliadas

| Método | Prazo típico | Depende de | Robustez | Papel no plano |
|---|---|---|---|---|
| A. Nova liberação de IP pela EDP | Dias a semanas | TI (IP reservado) e EDP | Alta | Definitivo |
| B. Saída pela rede da Engelmig | Dias | TI | Alta | Definitivo |
| C. Relay de saída | Horas | Uma máquina na rede da Engelmig | Média no desktop, alta em servidor | Imediato e transição |
| D. Coleta no servidor interno | Dias | Servidor interno e ajustes de código | Alta | Definitivo alternativo |
| E. VPN na VM | Horas | Credenciais pessoais e MFA | Baixa | Não recomendado |

---

## 6. Plano recomendado

**Fase 1, imediata.** Método C com o desktop como relay (seção 9.4). Objetivo: o WPA Monitor volta a coletar enquanto as soluções definitivas são providenciadas.

**Fase 2, curto prazo.**
- Migrar o relay para um servidor interno sempre ligado (seção 9.7), eliminando a dependência do desktop e da VPN.
- Abrir com a TI o pedido de IP reservado para a VM e a avaliação do Método B.
- Enviar à EDP o pedido de liberação (Método A), depois que a TI confirmar o IP definitivo.

**Fase 3, definitiva.** Quando o Método A ou o Método B estiver ativo e validado, desativar o relay (seção 9.10).

---

## 7. Método A: nova liberação de IP pela EDP

### 7.1 Quando usar

Sempre, como solução definitiva preferencial: devolve à VM o acesso direto, sem peças intermediárias. O pedido só deve ser enviado depois que o IP da VM estiver garantido como fixo, para que a liberação não se perca de novo.

### 7.2 Passo 1: garantir um IP fixo na OCI (TI)

Na OCI, a VM sai para a internet de uma destas formas:

- **IP público ligado à interface da VM.** Pode ser **efêmero** (vale enquanto a instância existir e muda se ela ou a interface forem recriadas) ou **reservado** (pertence à conta e permanece o mesmo).
- **NAT gateway da subrede.** Todas as VMs da subrede saem pelo IP do gateway, que muda se o gateway for recriado, a não ser que tenha sido criado com IP reservado.

Pedido à TI:

1. Informar por qual mecanismo a VM 172.25.3.154 sai para a internet.
2. Se o IP for efêmero, substituí-lo por um IP reservado (ou garantir que o NAT gateway use IP reservado).
3. Confirmar por escrito o IP final, que será enviado à EDP.

### 7.3 Passo 2: pedido formal à EDP

Enviar pelo canal oficial do contrato, com cópia ao gestor responsável. Modelo:

```
Assunto: Solicitação de liberação de IP para a integração Engelmig com a API WPA

Prezados,

A Engelmig Energia mantém uma integração automatizada com a API do WPA,
utilizada no acompanhamento operacional dos contratos [CONTRATOS ATENDIDOS].
A integração autentica com o CompanyId da Engelmig e token JWT, conforme o
fluxo vigente.

Desde [DATA], as requisições originadas do servidor da integração deixaram de
ser aceitas. Solicitamos a inclusão do endereço abaixo na lista de IPs
autorizados da API:

- IP de origem: [IP RESERVADO CONFIRMADO PELA TI]
- Finalidade: consulta automatizada dos dados operacionais do WPA
- Frequência aproximada das consultas: [EX.: A CADA 15 MINUTOS]
- Responsável técnico: [NOME, E-MAIL E TELEFONE]

Caso tenha havido mudança na política de acesso à API, pedimos a gentileza de
nos orientar sobre o procedimento e os requisitos atuais.

Atenciosamente,
[NOME]
[CARGO] | Engelmig Energia
```

### 7.4 Validação

Depois da confirmação da EDP, na VM e sem proxy:

```bash
curl -s https://ifconfig.me; echo                     # deve mostrar o IP liberado
curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 https://edp-wpa-web-api.azurewebsites.net/
```

Com a API respondendo diretamente, remova a variável `WPA_PROXY` dos processos (seção 9.6), acompanhe as coletas por 24 horas e então desative o relay (seção 9.10).

### 7.5 Vantagens e limitações

- **Vantagens:** solução mais simples de operar; nenhuma dependência de outra máquina; acesso formalmente autorizado pela EDP.
- **Limitações:** prazo depende da EDP; se a política da EDP mudou (por exemplo, recusa de IPs de nuvem), o pedido pode ser negado, e aí o Método B ou o D passa a ser o definitivo.

---

## 8. Método B: saída pela rede da Engelmig, configurada pela TI

### 8.1 Quando usar

Quando a EDP aceita apenas o IP da rede corporativa, ou quando se prefere não depender de nova liberação. A VM passa a chegar à EDP pela mesma saída que o desktop usa com a VPN, sem túnel, proxy ou mudança de código.

### 8.2 Por que tende a ser viável

A VM é acessada pelo IP privado 172.25.3.154 a partir da rede da Engelmig, o que indica que já existe um link privado entre a rede corporativa e a rede da VM na OCI (Site-to-Site VPN ou equivalente, terminando no FortiGate). Se for o caso, a TI não precisa criar infraestrutura nova, só ajustar rotas e políticas.

### 8.3 O que pedir à TI

Há duas variantes; a escolha é da TI:

**B1. Rota específica para a EDP.**
- Na tabela de rotas da subrede da VM, uma regra enviando o tráfego destinado aos IPs da API WPA para o gateway do link privado (DRG), em vez da internet.
- No FortiGate, uma política permitindo esse tráfego da rede da OCI para a internet, com NAT para o IP público corporativo que a EDP aceita.
- Ponto de atenção: as rotas da OCI usam faixas de IP. Os dois hosts da EDP são `*.azurewebsites.net` (Azure App Service), cujos IPs são compartilhados com outros clientes do Azure e podem mudar. Na prática, B1 só é viável se a EDP informar IPs fixos de saída; caso contrário, adote a variante B2.

**B2. Saída total pela Engelmig.**
- A rota padrão (`0.0.0.0/0`) da subrede da VM passa a apontar para o link privado, e toda a navegação da VM sai pela Engelmig.
- Mais simples de manter (não depende dos IPs da EDP), mas todo o tráfego de internet da VM passa a consumir o link e as políticas do FortiGate.

### 8.4 Validação

```bash
curl -s https://ifconfig.me; echo      # na variante B2, deve mostrar o IP corporativo
curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 https://edp-wpa-web-api.azurewebsites.net/
```

Na variante B1, o `ifconfig.me` continua mostrando o IP da Oracle, mas a chamada à API deve deixar de ser recusada.

### 8.5 Vantagens e limitações

- **Vantagens:** transparente para a aplicação; usa o IP que a EDP já aceita; operação e monitoramento ficam com a TI.
- **Limitações:** depende de agenda e aprovação da TI; na variante B1, depende de IPs estáveis da API.

---

## 9. Método C: relay de saída (proxy restrito e túnel SSH reverso)

### 9.1 Como funciona

As aplicações continuam na VM. Só as chamadas HTTPS para a EDP passam por uma máquina da rede da Engelmig (o "relay"), cujo IP a EDP aceita.

```
VM (WPA Monitor, ETL)
  | chamada HTTPS para a EDP, via proxy 127.0.0.1:3128
  v
porta 3128 da VM
  | túnel SSH reverso, aberto pela máquina relay até a VM
  v
porta 3128 da máquina relay: proxy_edp.py (só hosts da EDP)
  |
  v
API WPA da EDP (vê o IP da rede da Engelmig)
```

Características:

- **Sem sudo e sem VPN na VM.** O túnel é um SSH comum, aberto de dentro da rede da Engelmig para a VM, e o servidor SSH da VM já permite túneis.
- **Sem abertura de portas na Engelmig.** A conexão parte de dentro para fora.
- **Criptografia de ponta a ponta preservada.** O proxy só repassa bytes do HTTPS entre a aplicação e a EDP; ele não vê o conteúdo nem o token.
- **Acesso restrito.** O proxy recusa qualquer destino fora da lista de hosts da EDP, então a VM não ganha acesso à rede interna da Engelmig.

### 9.2 Pré-requisitos

- [x] Túnel reverso permitido no servidor SSH da VM (verificado em 23/10/2026)
- [ ] Porta 3128 livre na VM: `ss -ltn | grep ':3128 ' || echo "3128 livre"`
- [ ] Python 3.8 ou superior na máquina relay
- [x] Hosts da EDP do WPA Monitor levantados (seção 3.2); hosts dos scripts de ETL a conferir (seção 4.4)
- [ ] Máquina relay saindo por IP aceito pela EDP (desktop com VPN, ou servidor da rede corporativa)

Se a porta 3128 estiver ocupada, use outra (por exemplo, 3129) no lado da VM em todos os comandos e na variável `WPA_PROXY`.

### 9.3 Configurar o proxy

O código completo está no Anexo A e no repo, em `scripts/relay-wpa/proxy_edp.py`, já com os dois hosts do WPA Monitor em `PERMITIDOS`:

```python
PERMITIDOS = {
    "edp-wpa-po.azurewebsites.net",        # login (WPA_URL)
    "edp-wpa-web-api.azurewebsites.net",   # Web API (WPA_API_URL)
}
```

Se os scripts de ETL usarem outro host da EDP, acrescente-o, em minúsculas e sem `https://`.

Execute:

```bash
python proxy_edp.py        # no Windows: py proxy_edp.py
```

**Desktop Windows sem Python** (24/10/2026, o desktop do relay não tinha Python): use `scripts/relay-wpa/proxy_edp.ps1`, que faz o mesmo no Windows PowerShell 5.1, ou o `scripts/relay-wpa/iniciar_relay.ps1`, que sobe o proxy em PowerShell numa janela própria, confere se a EDP responde 200 a partir do desktop e abre o túnel com reconexão automática:

```powershell
scp usr_jose@172.25.3.154:prod-stc/scripts/relay-wpa/proxy_edp.ps1 $HOME\
scp usr_jose@172.25.3.154:prod-stc/scripts/relay-wpa/iniciar_relay.ps1 $HOME\
powershell -ExecutionPolicy Bypass -File $HOME\iniciar_relay.ps1
```

Saída esperada:

```
2026-10-24 08:00:00 proxy em 127.0.0.1:3128, liberado para: edp-wpa-po.azurewebsites.net, edp-wpa-web-api.azurewebsites.net
```

O proxy escuta apenas em `127.0.0.1`, então não fica acessível pela rede local da máquina relay. Cada conexão gera uma linha de log: `OK <host>` para as liberadas, `RECUSADO <destino>` para as bloqueadas e `SEM ROTA <host>` quando a máquina relay não alcança a EDP (nesse caso o proxy responde 502).

### 9.4 Modo paliativo: desktop com VPN

1. Conecte a VPN corporativa no desktop.
2. Inicie o proxy no PowerShell (seção 9.3) e deixe a janela aberta.
3. No Termius, em Port Forwarding, crie uma regra do tipo **Remote** (os nomes dos campos podem variar conforme a versão):

   | Campo | Valor | Lado |
   |---|---|---|
   | Host | VM 172.25.3.154 (host já cadastrado) | |
   | Bind address | 127.0.0.1 | VM |
   | Port from | 3128 | VM |
   | Destination address | 127.0.0.1 | desktop |
   | Destination port | 3128 | desktop |

4. Salve e ative a regra. Ela abre uma conexão própria com a VM, com as credenciais já salvas no Termius.

Alternativa sem Termius, pelo cliente SSH do Windows, no PowerShell:

```powershell
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R localhost:3128:127.0.0.1:3128 usr_jose@172.25.3.154
```

Se a conexão no Termius usa chave, exporte a chave e informe com `-i caminho\da\chave`.

Na VM, confirme que o túnel subiu:

```bash
ss -ltn | grep ':3128 '      # deve aparecer 127.0.0.1:3128 em LISTEN
```

**Limitações deste modo:** o relay só existe enquanto o desktop estiver ligado, sem hibernar, com a VPN conectada e com a regra do Termius (ou a janela do PowerShell) ativa. Serve para validar a solução e retomar as coletas, não para operação contínua.

### 9.5 Testes na VM

```bash
curl -s -o /dev/null -w "%{http_connect} %{http_code}\n" --max-time 15 \
  -x http://127.0.0.1:3128 https://edp-wpa-web-api.azurewebsites.net/
```

O primeiro número é a resposta do proxy; o segundo, a resposta da EDP.

| Resultado | Significado | Ação |
|---|---|---|
| `200 2xx/4xx` (ex.: `200 200`, `200 401`) | Túnel e proxy funcionando; a requisição chegou à EDP | Seguir para a seção 9.6 |
| `403 000` | O proxy recusou o destino | Conferir o log (`RECUSADO`) e incluir o host em `PERMITIDOS` |
| `000 000` | Não há proxy respondendo na porta 3128 da VM | Verificar túnel, proxy e VPN (seção 12) |
| `502 000` | O proxy está no ar, mas a máquina relay não alcança a EDP | Conferir a VPN ou a rede da máquina relay (log `SEM ROTA`) |

Para confirmar o IP que a EDP passa a enxergar, inclua temporariamente `ifconfig.me` em `PERMITIDOS`, reinicie o proxy e execute:

```bash
curl -s -x http://127.0.0.1:3128 https://ifconfig.me; echo
```

O resultado deve ser o IP anotado na seção 4.2, e não 144.22.240.169. Depois do teste, retire `ifconfig.me` da lista.

### 9.6 Ajustar a aplicação

**Princípio:** só o cliente HTTP que fala com a EDP usa o proxy. Para isso, use uma variável própria, `WPA_PROXY=http://127.0.0.1:3128`. Não defina `HTTPS_PROXY` de forma global: as demais chamadas HTTPS da aplicação seriam recusadas pelo proxy, que só aceita hosts da EDP. Com a variável vazia ou ausente, o código volta a chamar a EDP diretamente, o que facilita a transição para os métodos A e B.

**Python com `requests`** (scripts de ETL):

```python
import os
import requests

wpa = requests.Session()
if os.getenv("WPA_PROXY"):
    wpa.proxies = {"https": os.environ["WPA_PROXY"]}

# todas as chamadas à API WPA passam a usar a sessão "wpa"
resp = wpa.get(url, headers=headers, timeout=60)
```

Com `httpx`, o equivalente é `httpx.Client(proxy=os.getenv("WPA_PROXY"))`.

Se os scripts rodam pelo cron do usuário, declare a variável no topo do `crontab -e`. Como o nome é próprio, ela não afeta outros programas:

```
WPA_PROXY=http://127.0.0.1:3128
```

**WPA Monitor (Node.js): já implementado.** Todo HTTP para a EDP sai por um único ponto, `services/wpaHttp.js` (`wpaHttpFetch`, sobre node-fetch@2), usado pelo login e pela Web API em `services/wpaService.js` e pelo diagnóstico em `routes/index.js`. Desde 24/10/2026 esse ponto lê `WPA_PROXY`:

- Com `WPA_PROXY` preenchido, as URLs `https` para a EDP abrem um túnel `CONNECT` no proxy e fazem o TLS com a EDP por dentro dele. O certificado continua sendo validado contra o host da EDP. Não há dependência nova: o túnel usa só `http` e `tls` do Node.
- Vazio ou ausente, a chamada vai direto, como antes.
- A variável é lida a cada chamada, mas o `.env` só é carregado no start do processo. Por isso, ative no `.env` da VM e reinicie do jeito do runbook (CLAUDE.md, regra 4):

```bash
echo "WPA_PROXY=http://127.0.0.1:3128" >> ~/prod-stc/.env
```

```bash
cd ~/prod-stc && pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save
```

**Tratamento de falha (WPA Monitor).** Toda falha de acesso à EDP vira um `WpaAccessError` (`services/wpaErros.js`), nunca lista vazia:

| Situação | `code` |
|---|---|
| Nada escutando na 3128, túnel no ar com o proxy parado, ou sem resposta ao `CONNECT` em 10 s | `WPA_PROXY_INDISPONIVEL` |
| Proxy respondeu `403` (host fora de `PERMITIDOS`) ou outro status ao `CONNECT` | `WPA_PROXY_RECUSOU` |
| Proxy respondeu `502` (a máquina relay não alcança a EDP) | `WPA_PROXY_SEM_ROTA` |
| `403` com a página "Web App - Unavailable" / "has blocked your access" do Azure | `WPA_IP_BLOQUEADO` |
| Qualquer outro status fora de 2xx | `WPA_HTTP_<status>` |
| 2xx que não é JSON | `WPA_RESPOSTA_INVALIDA` |
| DNS, conexão, TLS ou timeout sem proxy | `WPA_REDE` |

No contador do P0-11 (`GET /api/admin/wpa-requisicoes`) as falhas do proxy aparecem pelo próprio `code`, separadas de `rede`, `timeout` e dos códigos HTTP da EDP. Para conferir o caminho sem credenciais, na raiz do projeto: `node scripts/check-wpa.js` (sai com 0 quando a API de dados responde).

**Testes:** `node --test test/wpaProxy.test.js` (proxy falso local; nada sai para a internet).

### 9.7 Modo definitivo: servidor interno

#### 9.7.1 Escolha do servidor

O relay definitivo deve rodar numa máquina que: fique sempre ligada; esteja na rede da Engelmig e saia para a internet por IP aceito pela EDP (sem precisar de VPN); e alcance a VM em 172.25.3.154, porta 22. O servidor que hoje faz a injeção do token atende, em princípio, a todos esses critérios.

#### 9.7.2 Chave SSH dedicada

No servidor relay, com o usuário que executará o túnel:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/relay_wpa -N "" -C relay-wpa
cat ~/.ssh/relay_wpa.pub
```

Na VM, acrescente ao `~/.ssh/authorized_keys` uma linha com a chave pública precedida de restrições (tudo numa linha só):

```
restrict,port-forwarding,permitlisten="localhost:3128",command="/bin/false" ssh-ed25519 AAAA...chave... relay-wpa
```

| Opção | Efeito |
|---|---|
| `restrict` | Desliga tudo por padrão: encaminhamentos, terminal, agente, X11 |
| `port-forwarding` | Reativa apenas o encaminhamento de portas |
| `permitlisten="localhost:3128"` | Permite abrir somente a porta 3128, somente em localhost, na VM |
| `command="/bin/false"` | Impede a execução de shell ou de qualquer comando com essa chave |

Assim, mesmo que a chave vaze, ela só serve para abrir esse túnel. Nada disso exige sudo. Confira as permissões na VM:

```bash
chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
```

#### 9.7.3 Primeira conexão

O SSH precisa registrar a identidade da VM antes de rodar sem supervisão. No servidor relay, uma vez, de forma manual:

```bash
ssh -N -i ~/.ssh/relay_wpa -R localhost:3128:127.0.0.1:3128 usr_jose@172.25.3.154
```

Confirme a impressão digital apresentada (pode ser conferida na VM com `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), responda `yes` e encerre com `Ctrl+C`.

#### 9.7.4 Servidor Linux com systemd

Copie o `proxy_edp.py` para `/opt/relay-wpa/` e crie um usuário de serviço (no exemplo, `relay`, dono da chave da seção 9.7.2).

`/etc/systemd/system/relay-wpa-proxy.service`:

```ini
[Unit]
Description=Proxy restrito para a API WPA da EDP
After=network-online.target
Wants=network-online.target

[Service]
User=relay
ExecStart=/usr/bin/python3 /opt/relay-wpa/proxy_edp.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/relay-wpa-tunel.service`:

```ini
[Unit]
Description=Tunel SSH reverso para a VM do WPA Monitor
After=network-online.target relay-wpa-proxy.service
Wants=network-online.target

[Service]
User=relay
ExecStart=/usr/bin/ssh -N -i /home/relay/.ssh/relay_wpa \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes -o BatchMode=yes \
  -R localhost:3128:127.0.0.1:3128 usr_jose@172.25.3.154
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
```

Ativação:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now relay-wpa-proxy relay-wpa-tunel
journalctl -u relay-wpa-tunel -f        # acompanhar o túnel
```

#### 9.7.5 Servidor Linux sem acesso root

Use o cron do próprio usuário. Crie `~/relay-wpa/tunel_wpa.sh`:

```bash
#!/usr/bin/env bash
while true; do
  ssh -N -i ~/.ssh/relay_wpa \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes -o BatchMode=yes \
      -R localhost:3128:127.0.0.1:3128 usr_jose@172.25.3.154
  sleep 15
done
```

E no `crontab -e`:

```
@reboot /usr/bin/python3 $HOME/relay-wpa/proxy_edp.py >> $HOME/relay-wpa/proxy.log 2>&1
@reboot /bin/bash $HOME/relay-wpa/tunel_wpa.sh >> $HOME/relay-wpa/tunel.log 2>&1
```

#### 9.7.6 Servidor Windows

Use uma conta dedicada; a chave e o arquivo `known_hosts` precisam estar no perfil dela. Crie `C:\relay-wpa\tunel_wpa.ps1`:

```powershell
$chave = "$env:USERPROFILE\.ssh\relay_wpa"
while ($true) {
    ssh -N -i $chave -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
        -o ExitOnForwardFailure=yes -o BatchMode=yes `
        -R localhost:3128:127.0.0.1:3128 usr_jose@172.25.3.154
    Start-Sleep -Seconds 15
}
```

No Agendador de Tarefas, crie duas tarefas com o gatilho "Ao iniciar o sistema", a opção "Executar estando o usuário conectado ou não" e a conta dedicada:

| Tarefa | Programa | Argumentos |
|---|---|---|
| Relay WPA proxy | Caminho completo do `python.exe` | `C:\relay-wpa\proxy_edp.py` |
| Relay WPA túnel | `powershell.exe` | `-NoProfile -ExecutionPolicy Bypass -File C:\relay-wpa\tunel_wpa.ps1` |

Nas configurações da tarefa, desmarque a interrupção por tempo de execução e marque o reinício em caso de falha.

### 9.8 Monitoramento na VM

Script que registra quando o relay está fora do ar, `~/bin/check_relay_wpa.sh`:

```bash
#!/usr/bin/env bash
HOST_API="edp-wpa-web-api.azurewebsites.net"
LOG="$HOME/logs/relay_wpa.log"
mkdir -p "$HOME/logs"
resultado=$(curl -s -o /dev/null -w "%{http_connect} %{http_code}" --max-time 15 \
            -x http://127.0.0.1:3128 "https://$HOST_API/")
if [ "${resultado%% *}" != "200" ]; then
  echo "$(date '+%F %T') FALHA relay WPA: $resultado" >> "$LOG"
fi
```

Agendamento no `crontab -e` da VM (o cron do usuário não exige sudo):

```
*/5 * * * * /bin/bash $HOME/bin/check_relay_wpa.sh
```

Se fizer sentido, o mesmo teste pode virar um indicador de status no próprio WPA Monitor.

### 9.9 Segurança do relay

- O proxy só aceita conexões vindas de `127.0.0.1` e só encaminha para os hosts da EDP na porta 443.
- O túnel abre a porta 3128 apenas no `localhost` da VM.
- A chave do servidor relay não permite shell nem outras portas (seção 9.7.2).
- Risco residual: qualquer processo ou usuário da VM consegue usar a porta 3128, mas apenas para alcançar os hosts da EDP, e ainda precisaria das credenciais da API.
- A TI deve estar ciente do túnel, por ser um caminho permanente entre a nuvem e uma máquina da rede interna, ainda que restrito.

### 9.10 Desativação

Quando o Método A ou o B estiver validado:

1. Remover `WPA_PROXY` do `.env` do WPA Monitor (e reiniciar com `pm2 delete wpa-monitor && pm2 start ecosystem.config.js && pm2 save`) e do crontab da VM, reiniciando as demais aplicações.
2. Confirmar as coletas por 24 horas sem o proxy.
3. Parar o relay: desativar a regra do Termius, os serviços do systemd (`sudo systemctl disable --now relay-wpa-tunel relay-wpa-proxy`), as linhas do cron ou as tarefas do Windows.
4. Remover da VM a linha da chave `relay-wpa` no `~/.ssh/authorized_keys`.
5. Remover o agendamento do `check_relay_wpa.sh`.

---

## 10. Método D: coleta executada no servidor interno

### 10.1 Ideia

Inverter o fluxo: em vez de a VM buscar os dados na EDP, o servidor interno da Engelmig executa a coleta e envia o resultado para a VM. É a extensão natural do que já acontece com o token, que esse servidor obtém e injeta na VM.

### 10.2 Formas de envio

- **Endpoint de ingestão no WPA Monitor.** O servidor interno coleta na API WPA e envia os dados por HTTP para uma rota protegida por token na VM. É a opção mais adequada para o WPA Monitor (Postgres local via `services/pgShim.js`), porque a gravação e a consolidação continuam sendo feitas pela própria aplicação, com os mesmos upserts idempotentes do cron. Exige mudança de código; o esboço abaixo é só ilustrativo:

  ```js
  app.post('/ingestao/wpa', express.json({ limit: '20mb' }), (req, res) => {
    if (req.get('Authorization') !== `Bearer ${process.env.INGESTAO_TOKEN}`) {
      return res.status(401).end();
    }
    // gravar req.body com a mesma lógica (e os mesmos upserts idempotentes) da coleta
    res.status(204).end();
  });
  ```

- **Gravação direta no PostgreSQL.** Para os scripts de ETL, o servidor interno executa o script e grava no banco da VM através de um túnel SSH local, sem expor a porta do banco:

  ```bash
  ssh -N -L 15432:127.0.0.1:5432 usr_jose@172.25.3.154 &
  # o script passa a usar host=127.0.0.1 e port=15432
  ```

### 10.3 Vantagens e limitações

- **Vantagens:** não depende de túnel permanente para a VM consultar a EDP; usa o IP que a EDP já aceita; elimina a injeção de token como etapa separada.
- **Limitações:** exige mudanças de código e divide a lógica entre duas máquinas; a coleta passa a depender da disponibilidade do servidor interno, assim como no Método C.

---

## 11. Método E: cliente de VPN na VM (não recomendado)

Instalar o openconnect (compatível com a SSL VPN da Fortinet) e o ocproxy no diretório do usuário permitiria conectar a VM à VPN corporativa sem sudo. Foi avaliado e descartado para uso contínuo pelos seguintes motivos:

- **Autenticação manual:** cada conexão exige senha e token de MFA digitados por uma pessoa.
- **Quedas previsíveis:** o FortiGate encerra sessões por tempo máximo (8 horas na configuração padrão) e por inatividade; a VM não reconecta sozinha.
- **Credenciais pessoais em produção:** a integração ficaria presa ao usuário de VPN de um colaborador.
- **Exposição da rede interna:** o proxy SOCKS do ocproxy daria à VM acesso a tudo que a VPN alcança, não só à EDP.
- **Compatibilidade incerta:** a partir do FortiOS 7.6.3 a Fortinet removeu o modo túnel da SSL VPN, substituído por IPsec. Se a VPN corporativa já estiver em IPsec, o método é inviável sem root.
- **Visibilidade:** o FortiGate registraria um login vindo de IP da Oracle, com cliente que não é o FortiClient; se houver limite de uma sessão por usuário, a conexão da VM derrubaria a do desktop.

Uso aceitável: somente execução manual e pontual, com a TI ciente, e apenas se o perfil da VPN no FortiClient for do tipo SSL-VPN. Referência técnica: Ubuntu 24.04 fornece openconnect 9.12 (`--protocol=fortinet`, modo `--script-tun`) e ocproxy, que podem ser extraídos no diretório do usuário com `apt-get download` e `dpkg -x`.

---

## 12. Solução de problemas

| Sintoma | Causa provável | Ação |
|---|---|---|
| `remote port forwarding failed for listen port 3128` | Porta ocupada na VM, inclusive por um túnel anterior que não fechou | Na VM, `ss -ltnp \| grep ':3128 '`; encerrar a sessão antiga ou trocar a porta |
| Teste da seção 9.5 retorna `000 000` | Túnel fechado, proxy parado ou, no modo paliativo, VPN desconectada | Conferir a janela do proxy, a regra do Termius ou o serviço do túnel e a VPN |
| Teste retorna `403 000` | Destino fora de `PERMITIDOS` | Ver no log do proxy a linha `RECUSADO` e incluir o host |
| Log do proxy mostra `ERRO TimeoutError` ou `gaierror` | A máquina relay não resolve ou não alcança a EDP | Testar o acesso à API no navegador da máquina relay |
| EDP responde `403` mesmo via proxy | O IP de saída do relay não é aceito, ou a aplicação não está usando o proxy | Testar `ifconfig.me` pelo proxy (seção 9.5) e conferir a variável `WPA_PROXY` no processo |
| Erro de certificado na VM (`unable to get local issuer certificate`, `self-signed certificate`) | Inspeção SSL do FortiGate no tráfego da VPN, que troca o certificado da EDP | Pedir à TI exceção de inspeção para os hosts da EDP. Como alternativa, confiar na CA da Fortinet na aplicação: no Node, `NODE_EXTRA_CA_CERTS` precisa estar no ambiente **antes** do processo subir (bloco `env` do `ecosystem.config.js` ou o shell que roda o `pm2 start`), porque o `.env` é lido tarde demais para ela; no Python, bundle de CA |
| Outras chamadas HTTPS da aplicação passam a falhar | `HTTPS_PROXY` definido de forma global | Remover `HTTPS_PROXY` e usar apenas `WPA_PROXY` |
| Funciona e para depois de algum tempo | Desktop hibernou, VPN caiu ou Termius fechou | Esperado no modo paliativo; migrar para o servidor interno (seção 9.7) |
| Contador ou log do WPA Monitor com `WPA_PROXY_INDISPONIVEL` | O WPA Monitor não conseguiu abrir o túnel | Mesmo diagnóstico do `000 000`: túnel, proxy e VPN. `node scripts/check-wpa.js` confirma |
| Contador ou log com `WPA_PROXY_SEM_ROTA` | Proxy no ar, máquina relay sem acesso à EDP | Mesmo diagnóstico do `502 000`: VPN da máquina relay |
| `Permission denied (publickey)` no servidor relay | Chave não cadastrada na VM ou permissões incorretas | Conferir a linha no `authorized_keys` e as permissões 700/600 |
| `Host key verification failed` no serviço do túnel | Primeira conexão não registrada | Fazer a conexão manual da seção 9.7.3 com o mesmo usuário do serviço |

---

## 13. Governança e segurança

- **TI informada:** qualquer caminho permanente entre a nuvem e a rede interna (Métodos B, C e D) deve ser conhecido e aprovado pela TI.
- **EDP pelo canal formal:** pedidos e esclarecimentos sobre a lista de IPs passam pelo gestor do contrato.
- **Sem credenciais pessoais em produção:** a integração não deve depender de usuário de VPN, senha ou MFA de um colaborador.
- **Menor privilégio:** o relay alcança apenas os hosts da EDP; a chave do túnel só abre uma porta; o proxy só escuta em `127.0.0.1`.
- **Registro:** manter este manual atualizado com o método em uso, as máquinas envolvidas, os responsáveis e o procedimento de desativação.
- **Transitoriedade do relay:** o Método C é ponte até a solução definitiva; após a validação do Método A ou B, aplicar a seção 9.10.

---

## 14. Checklist final

**Diagnóstico**
- [ ] IP autorizado anteriormente comparado com 144.22.240.169 (4.1)
- [ ] IP aceito pela EDP anotado (4.2)
- [ ] Tipo de bloqueio identificado (4.3)
- [ ] Hosts da EDP levantados (4.4; os do WPA Monitor já estão na seção 3.2)

**Fase 1: relay paliativo**
- [ ] Porta 3128 livre na VM
- [ ] Proxy rodando no desktop com `PERMITIDOS` preenchido
- [ ] Túnel ativo (Termius ou PowerShell) e `127.0.0.1:3128` em LISTEN na VM
- [ ] Teste da seção 9.5 retornando `200` no primeiro número
- [ ] IP visto pela EDP conferido via `ifconfig.me` pelo proxy
- [x] WPA Monitor com suporte a `WPA_PROXY` no código (`services/wpaHttp.js`, 24/10/2026)
- [ ] `WPA_PROXY` no `.env` da VM, `pm2` reiniciado e coletas retomadas (`node scripts/check-wpa.js` sai com 0; contador sem `WPA_PROXY_*`)
- [ ] Scripts de ETL ajustados com `WPA_PROXY`

**Fase 2: transição**
- [ ] Relay migrado para servidor interno, com chave restrita e reinício automático
- [ ] Monitoramento do relay agendado na VM
- [ ] Pedido de IP reservado e avaliação do Método B abertos com a TI
- [ ] Pedido de liberação enviado à EDP com o IP definitivo

**Fase 3: definitivo**
- [ ] Método A ou B ativo e validado por 24 horas
- [ ] Relay desativado conforme a seção 9.10
- [ ] Manual atualizado com a configuração final

---

## Anexo A: código do `proxy_edp.py`

Somente biblioteca padrão do Python 3.8 ou superior. Funciona em Linux e Windows. Testado com cliente `curl` e `requests`: o host liberado é encaminhado, qualquer outro recebe `403`. A cópia de referência fica no repo, em `scripts/relay-wpa/proxy_edp.py`.

```python
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
```

---

## Anexo B: referência rápida de comandos

**Na VM**

```bash
curl -s https://ifconfig.me; echo                                  # IP público de saída
ss -ltn | grep ':3128 ' || echo "3128 livre"                       # porta do túnel
curl -s -o /dev/null -w "%{http_connect} %{http_code}\n" --max-time 15 \
  -x http://127.0.0.1:3128 https://edp-wpa-web-api.azurewebsites.net/                # teste do relay
curl -s -x http://127.0.0.1:3128 https://ifconfig.me; echo         # IP visto pela EDP (com ifconfig.me liberado no proxy)
grep -riE "AllowTcpForwarding|DisableForwarding" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null
```

**Na máquina relay**

```bash
python proxy_edp.py                                                # iniciar o proxy (Windows: py proxy_edp.py)
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  -R localhost:3128:127.0.0.1:3128 usr_jose@172.25.3.154            # abrir o túnel manualmente
ssh-keygen -t ed25519 -f ~/.ssh/relay_wpa -N "" -C relay-wpa        # gerar a chave dedicada
```
