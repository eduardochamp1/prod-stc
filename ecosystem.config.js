module.exports = {
  apps: [{
    name:        'wpa-monitor',
    script:      'server.js',
    instances:   1,
    autorestart: true,
    watch:       false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      // HERE Routing API key — pega gratis em https://platform.here.com
      // (Access Manager -> App -> Credentials -> REST API Keys). Free tier
      // permanente: 250k req/mes. Quando vazio, o app cai pro OSRM publico
      // (que o Fortinet bloqueia em prod). NAO commitar a key real aqui;
      // editar este arquivo direto no servidor e nao versionar a mudanca.
      HERE_API_KEY: '',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:  './logs/err.log',
    out_file:    './logs/out.log',
    merge_logs:  true,
  }],
};
