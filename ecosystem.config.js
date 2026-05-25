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
      // OSRM via HTTP (nao HTTPS): firewall corporativo da Engelmig (Fortinet)
      // faz TLS interception e a CA raiz nao esta acessivel no servidor.
      // OSRM publico aceita HTTP no mesmo endpoint. Payload e benigno
      // (coords + duracao), nao tem auth/segredo trafegando.
      OSRM_HOST: 'http://router.project-osrm.org',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:  './logs/err.log',
    out_file:    './logs/out.log',
    merge_logs:  true,
  }],
};
