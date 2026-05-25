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
      // CA do Fortinet (firewall corporativo da Engelmig faz TLS interception).
      // Sem isso, qualquer fetch HTTPS de saida (OSRM, etc) falha com
      // "unable to verify the first certificate". O arquivo precisa existir
      // no servidor — gerar com:
      //   openssl s_client -showcerts -connect router.project-osrm.org:443 \
      //     -servername router.project-osrm.org < /dev/null 2>/dev/null \
      //     | awk '/BEGIN CERT/,/END CERT/' > ~/fortinet-ca.pem
      NODE_EXTRA_CA_CERTS: '/home/usr_jose/fortinet-ca.pem',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:  './logs/err.log',
    out_file:    './logs/out.log',
    merge_logs:  true,
  }],
};
