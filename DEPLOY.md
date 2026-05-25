# Deploy do WPA Monitor — Servidor Linux (Ubuntu/Debian)

Guia passo-a-passo para subir o WPA Monitor num servidor Linux novo
(substituindo o servidor PM2 atual da Engelmig).

> **Pré-requisitos atendidos neste roteiro**
> - Ubuntu / Debian com SSH e Node.js ≥ 18 instalado
> - IP de saída do servidor **já autorizado** na EDP para a API WPA
> - Acesso via VPN/rede privada (sem necessidade de domínio público nem HTTPS externo)
> - Banco de dados **Supabase** continua como produção (zero migração de dados)
> - Estratégia de transição: **substituição total** do servidor antigo

---

## Visão Geral da Arquitetura

```
┌──────────────────────────┐         ┌────────────────────────────┐
│ Servidor Linux (NOVO)    │         │ Vercel (frontend stand-by) │
│  Node.js + PM2           │ ──────▶ │  /api → Supabase (read-only)│
│  cronService             │         │  (sem cron, sem WPA)       │
│  DATA_MODE=wpa           │         └────────────────────────────┘
│  ├─ Snapshot a cada 15m  │
│  ├─ Token refresh        │                ▲
│  ├─ Classifier           │                │
│  └─ Webhook /webhook/deploy                │
│                                            │
│  IP autorizado → api.mobile.gestaoonlinewpa│
│  Porta 3002 → exposta na VPN               │
└────────────────┬─────────────────────────────┘
                 │
                 ▼
         ┌───────────────┐
         │   Supabase    │  (compartilhado)
         │   Postgres    │
         └───────────────┘
```

Pontos importantes:

- Só **um** servidor pode rodar com `DATA_MODE=wpa` por vez. Dois crons
  rodando em paralelo geram snapshots duplicados e dupla classificação.
- O Vercel sempre roda com `DATA_MODE=supabase` (modo read-only) — pode
  conviver com qualquer servidor WPA ativo.
- O webhook `/webhook/deploy` recebe push do GitHub e dispara
  `git pull && npm install && pm2 restart`.

---

## 1. Preparação no servidor

```bash
# Confirmar Node ≥ 18
node -v   # esperado: v18.x ou superior
npm -v

# Instalar PM2 globalmente (se ainda não tiver)
sudo npm install -g pm2

# Criar usuário dedicado (opcional, mas recomendado)
sudo useradd -m -s /bin/bash wpa
sudo usermod -aG sudo wpa     # se precisar permissão pra subir pm2 boot
sudo su - wpa
```

> Daqui pra frente assumo que você está logado como o usuário do app
> (seja `wpa`, `ubuntu` ou o que a TI da empresa criou). Ajuste paths
> em `/home/<usuário>/...` conforme necessário.

---

## 2. Clonar o repositório

```bash
cd /home/wpa
git clone https://github.com/eduardochamp1/prod-stc.git
cd prod-stc
npm install --production
```

> Token de acesso ao GitHub: se o repo for privado, configure uma
> deploy key SSH ou personal access token. Veja seção
> **Anexo A — Deploy key** no final.

---

## 3. Configurar `.env`

```bash
cp .env.example .env
nano .env
```

Cole os valores reais (peça à pessoa que mantém o servidor antigo o
`.env` atual — é o caminho mais seguro). Variáveis obrigatórias:

| Variável                | Valor                                                                 |
|-------------------------|------------------------------------------------------------------------|
| `DATA_MODE`             | `wpa`                                                                  |
| `WPA_URL`               | `https://edp-wpa-po.azurewebsites.net`                                 |
| `WPA_API_URL`           | `https://edp-wpa-web-api.azurewebsites.net`                            |
| `WPA_USERNAME`          | usuário corporativo Engelmig (mesmo do servidor antigo)                |
| `WPA_PASSWORD`          | senha entre aspas duplas                                                |
| `SUPABASE_URL`          | `https://iyadtjzehhebwojreudz.supabase.co`                             |
| `SUPABASE_SERVICE_KEY`  | service role key (a mesma — NUNCA expor no frontend)                   |
| `PORT`                  | `3002`                                                                  |
| `WEBHOOK_SECRET`        | string aleatória — usada também no GitHub webhook (passo 6)            |
| `JWT_SECRET`            | string aleatória longa — `openssl rand -hex 32` gera uma boa           |
| `AUTH_USERS`            | mesma string do servidor antigo (formato `usr:hash:role:reg,...`)      |

> ⚠ Se você gerar um `JWT_SECRET` novo, **todos os usuários logados são
> deslogados**. Pra evitar isso, reutilize o secret do servidor antigo.

Permissões do `.env`:

```bash
chmod 600 .env       # só o dono lê/escreve
```

---

## 4. Subir com PM2

O repo já tem `ecosystem.config.js` configurado. Crie a pasta de logs e dispare:

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 logs wpa-monitor --lines 40    # confirma boot, cron e Supabase ok
```

Saída esperada nos primeiros segundos:

```
  WPA Monitor — Engelmig Energia
  http://localhost:3002
  Modo    : wpa
  WPA URL : https://edp-wpa-po.azurewebsites.net
  Supabase: configurado ✓
  Webhook : configurado ✓
[CRON] Modo wpa — agendamentos iniciados.
```

Persistência entre reboots:

```bash
pm2 save
pm2 startup systemd
# Cole o comando sudo que o PM2 imprimir
```

---

## 5. Testar o serviço pela VPN

Do seu laptop, na VPN:

```bash
curl http://<IP-INTERNO-DO-SERVIDOR>:3002/health
# → {"ok":true,"ts":"..."}
```

Se quiser HTTPS interno via Nginx (opcional — recomendado se mais de
alguns usuários acessam), veja **Anexo B — Nginx + HTTPS interno**.

Se o `curl` falhar mas localmente no servidor funcionar:

```bash
sudo ufw allow 3002/tcp        # libera no firewall do servidor
# ou
sudo iptables -A INPUT -p tcp --dport 3002 -j ACCEPT
```

---

## 6. Webhook de deploy automático

GitHub → Settings → Webhooks → **Add webhook**:

| Campo         | Valor                                                      |
|---------------|-------------------------------------------------------------|
| Payload URL   | `http://<IP-INTERNO>:3002/webhook/deploy` (ou https interno)|
| Content type  | `application/json`                                          |
| Secret        | o mesmo `WEBHOOK_SECRET` do `.env`                          |
| Events        | apenas `push`                                               |

> **Atenção:** o webhook só funciona se o GitHub conseguir alcançar o
> servidor. Se ele está só na VPN, você tem 2 opções:
> 1. Expor o webhook por uma URL pública dedicada (Nginx + porta 443 com
>    cert) — só `/webhook/deploy`, o resto da app fica privado.
> 2. Manter sem webhook e fazer deploy manual:
>    ```bash
>    cd /home/wpa/prod-stc && git pull && npm install --production && pm2 restart wpa-monitor
>    ```

---

## 7. Cutover — substituir o servidor antigo

**Ordem importa** pra não rodar dois crons em paralelo.

```bash
# ── 7.1 — No servidor ANTIGO (não derrubar antes do passo 7.3 funcionar)
pm2 status                       # confirma quais apps rodam
pm2 stop wpa-monitor             # PARA o cron e a API
pm2 save                         # registra estado parado

# ── 7.2 — No servidor NOVO (já está rodando desde o passo 4)
pm2 logs wpa-monitor --lines 100 # confirma que o snapshot rodou e gravou
                                 # (procure por "snapshot ok teams=...")

# ── 7.3 — Confirmar dados novos no Supabase
# Olhe a tabela snapshots (Studio) ou:
curl http://<IP-NOVO>:3002/api/admin/health
# Deve mostrar Supabase=configurado e timestamp recente
```

Smoke test funcional pelo browser na VPN:
1. Abre `http://<IP-NOVO>:3002`
2. Faz login
3. Confere se aba **Monitor** carrega equipes com dados de hoje
4. Confere se aba **Rejeições** mostra contagens do mês

Se algo errado: `pm2 restart wpa-monitor` no antigo pra recuperar, e
investiga o que faltou no novo.

**Quando estiver tudo verde no novo, no antigo:**

```bash
pm2 delete wpa-monitor           # remove do PM2
pm2 save
# (opcional) parar o serviço completamente
# sudo systemctl disable pm2-<usuario>
```

---

## 8. Atualizar endpoints externos

Se você tem dashboards/integrações apontando pro IP antigo, atualizar:

- [ ] Webhook do GitHub (passo 6)
- [ ] Bookmarks dos usuários — mande comunicado com a nova URL
- [ ] Vercel: se o frontend tem chamadas pro servidor WPA via
      `WPA_PROXY_URL`, atualizar nas env vars (atualmente não é o caso —
      Vercel roda em `DATA_MODE=supabase` sem chamar o servidor WPA)

---

## Anexo A — Deploy key (repo privado)

```bash
ssh-keygen -t ed25519 -C "wpa-monitor@servidor-novo" -f ~/.ssh/github_deploy
cat ~/.ssh/github_deploy.pub
# Cola no GitHub → Settings → Deploy keys → Add (read-only basta)

# Configura SSH pra usar a key específica
cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

# Testa
ssh -T git@github.com
# → "Hi <user>! You've successfully authenticated..."

# Reconfigura o remote do clone pra SSH
cd /home/wpa/prod-stc
git remote set-url origin git@github.com:eduardochamp1/prod-stc.git
```

---

## Anexo B — Nginx + HTTPS interno (opcional)

Se a empresa tem CA interna ou você quer HTTPS no domínio interno
(`wpa.engelmig.local`, por exemplo):

```bash
sudo apt install nginx
sudo nano /etc/nginx/sites-available/wpa-monitor
```

Conteúdo:

```nginx
server {
  listen 80;
  server_name wpa.engelmig.local;

  location / {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wpa-monitor /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo ufw allow 80/tcp
# (HTTPS: adicione listen 443 ssl + paths dos certs corporativos)
```

Importante: depois disso, você pode fechar a porta 3002 ao público
externo e manter só o Nginx exposto.

---

## Anexo C — Troubleshooting

### `Supabase: não configurado` no boot
- Verifique `SUPABASE_SERVICE_KEY` no `.env` (service role, não a anon key)
- Reinicia: `pm2 restart wpa-monitor && pm2 logs --lines 30`

### Cron não dispara
- `process.env.DATA_MODE` precisa ser exatamente `wpa` (lowercase)
- `pm2 logs wpa-monitor | grep CRON` — deve mostrar `agendamentos iniciados`
- Confira fuso: o servidor deve estar em UTC ou BRT — o cron usa
  `America/Sao_Paulo` internamente, mas comportamento estranho aparece se
  o relógio do SO está deslocado:
  ```bash
  timedatectl
  sudo timedatectl set-timezone America/Sao_Paulo
  ```

### WPA retorna 403/401 esporadicamente
- IP de saída do servidor mudou? Confirme com:
  ```bash
  curl -s ifconfig.me
  ```
- Token expirado: o cron faz refresh a cada 5 min. Se isso falhar,
  `curl -X POST http://localhost:3002/api/admin/health` traz status.

### `EADDRINUSE :3002`
- Outra instância rodando: `pm2 list` e `pm2 delete <id>` ou
  `sudo lsof -i:3002` pra achar o PID.

### Logs grandes
- PM2 já rotaciona com `pm2 install pm2-logrotate`:
  ```bash
  pm2 install pm2-logrotate
  pm2 set pm2-logrotate:max_size 10M
  pm2 set pm2-logrotate:retain 14
  ```

---

## Anexo D — Comandos do dia-a-dia

```bash
# Status
pm2 status
pm2 logs wpa-monitor --lines 50
pm2 logs wpa-monitor --err            # só stderr

# Reiniciar (sem perder o cron)
pm2 restart wpa-monitor

# Atualizar manualmente
cd /home/wpa/prod-stc
git pull origin main
npm install --production
pm2 restart wpa-monitor

# Rodar backfill de rejeições pros últimos N dias
curl -X POST 'http://localhost:3002/api/admin/backfill-rejeicoes?days=30'

# Rodar snapshot manual (forçado)
curl -X POST 'http://localhost:3002/api/admin/snapshot'

# Sincronizar logoffs de um dia específico
curl -X POST 'http://localhost:3002/api/admin/sync-logoffs?date=2026-05-24'
```

---

## Checklist final

- [ ] Node ≥ 18 instalado, PM2 global
- [ ] Repo clonado em `/home/<user>/prod-stc`
- [ ] `.env` configurado com `DATA_MODE=wpa` e segredos reais (chmod 600)
- [ ] `pm2 start ecosystem.config.js` mostra "agendamentos iniciados"
- [ ] `curl http://localhost:3002/health` → `{ok:true}`
- [ ] `pm2 save && pm2 startup` configurado pra resistir reboot
- [ ] Porta 3002 liberada na VPN (firewall)
- [ ] (opcional) Nginx + HTTPS interno funcionando
- [ ] Webhook GitHub apontando pro novo IP/URL
- [ ] Servidor antigo parado (`pm2 stop wpa-monitor`)
- [ ] Smoke test no browser: login, Monitor, Rejeições, Gráficos
- [ ] Logs limpos por 1 hora (1 ciclo de snapshot inteiro)
