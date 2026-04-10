module.exports = {
  apps: [
    {
      name: 'fan_bot',
      script: 'src/index.ts',
      interpreter: 'npx',
      interpreter_args: 'tsx',
      cwd: '/Users/bytedance/work_code/fan_bot',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
