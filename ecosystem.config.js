module.exports = {
  apps: [{
    name:        'wpa-monitor',
    script:      'server.js',
    instances:   1,
    autorestart: true,
    watch:       false,
    // 1 GB: safety net. O fix real é classifierService serializar MD/SF + DD
    // e ceder event loop entre chunks (commit do fix definitivo, 28/05/2026).
    // Antes era 300M e pm2 reiniciou 161x num dia processando notas DD.
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      // Routing (deslocamentos): app usa OSRM via proxy Cloudflare Worker
      // configurado em OSRM_HOST do .env do servidor. Free tier permanente,
      // sem chave, sem cartao. Worker repassa pro router.project-osrm.org
      // (Fortinet bloqueia o dominio direto, mas libera o do Worker).
      // Codigo do Worker: https://dash.cloudflare.com -> Workers -> osrm-proxy
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:  './logs/err.log',
    out_file:    './logs/out.log',
    merge_logs:  true,
  }],
};
