module.exports = {
  apps: [
    {
      name: 'treeport',
      cwd: __dirname,
      script: 'scripts/start.mjs',
      kill_timeout: 10000,
      restart_delay: 5000,
      env: {
        TREEPORT_DAEMON_LIFECYCLE: 'external'
      }
    }
  ]
}
