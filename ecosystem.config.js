// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'i-store-be',
      script: 'dist/server.js',
      exec_mode: 'fork',      // change to 'cluster' + instances: 'max' if you want clustering
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        LOG_DIR: 'logs',
      },
      watch: false,
      max_memory_restart: '512M',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      time: true,
      env_file: '.env'
    },
  ],
};
