module.exports = {
  apps: [
    {
      name: 'crm-pilot-backend',
      cwd: '/home/krttpt/crm/backend',
      script: 'index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/home/krttpt/crm/logs/backend.out.log',
      error_file: '/home/krttpt/crm/logs/backend.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
