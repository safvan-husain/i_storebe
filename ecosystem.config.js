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
      },
      watch: false,
      max_memory_restart: '512M',
      // Optional: log paths (PM2 will create them). Without this, PM2 uses its own default logs dir.
      // error_file: 'logs/err.log',
      // out_file: 'logs/out.log',
      time: true,
    },
  ],
};
