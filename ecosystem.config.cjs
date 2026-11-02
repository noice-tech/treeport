module.exports = {
  apps: [
    {
      name: 'treeport',
      cwd: __dirname,
      script: 'scripts/start.mjs',
      // EXTERNAL: PM2 copies the calling shell's environment into the app on start and on
      // `pm2 restart ecosystem.config.cjs`. A Treeport terminal's environment describes the
      // instance that owns it, so this standalone server must not adopt any of it.
      filter_env: process.env.TREEPORT_DAEMON_RECORD ? ['TREEPORT_'] : false,
      kill_timeout: 10000,
      restart_delay: 5000
    }
  ]
}
