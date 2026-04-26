# WPA Monitor — Instalação Local (Windows)

## Pré-requisitos
- Node.js instalado (`node -v` no cmd para verificar)

## Estrutura
```
wpa-monitor/
├── backend/          ← servidor Express (porta 3002)
│   ├── src/
│   ├── .env          ← configurações
│   └── package.json
├── frontend/
│   └── index.html    ← abrir no navegador
└── iniciar.bat       ← duplo clique para iniciar
```

## Como rodar

### 1. Iniciar o backend
Dê duplo clique em `iniciar.bat`
Ou via terminal:
```cmd
cd backend
npm install
npm run dev
```

### 2. Abrir o painel
Abra o arquivo `frontend/index.html` no Chrome/Edge.

---

## Modos de dados

### Modo MOCK (padrão — sem VPN)
No arquivo `backend/.env`:
```
DATA_MODE=mock
```
Usa dados simulados. Funciona sem VPN ou GSEQ.

### Modo GSEQ (com VPN conectada)
```
DATA_MODE=gseq
GSEQ_URL=http://localhost:3000
CRON_SECRET=valor_do_cron_secret_do_gseq
```
Consome a API real do GSEQ.

---

## Pasta do projeto
```
C:\Users\jose.zouain\OneDrive - ENGELMIG ENERGIA LTDA\git\wpa-monitor
```
