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
      // Faz o Node usar o CA store do sistema (Ubuntu /etc/ssl/certs),
      // necessario quando o servidor esta atras de proxy corporativo
      // com TLS interception. Sem isso, fetch a OSRM/HTTPS publicos
      // quebra com "unable to verify the first certificate".
      NODE_OPTIONS: '--use-system-ca',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:  './logs/err.log',
    out_file:    './logs/out.log',
    merge_logs:  true,
  }],
};
