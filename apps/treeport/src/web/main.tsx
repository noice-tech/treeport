export {}

const status = document.getElementById('startup-status')!

const slowLoadTimer = window.setTimeout(() => {
  status.textContent =
    'Loading is taking longer than usual. Check your connection or reload Treeport.'
}, 10_000)

void import('./mount-app')
  .then(({ mountApp }) => {
    window.clearTimeout(slowLoadTimer)
    mountApp()
  })
  .catch((error) => {
    window.clearTimeout(slowLoadTimer)
    console.error('Treeport could not load', error)
    status.setAttribute('role', 'alert')
    status.textContent =
      'Treeport could not load. Check your connection and reload to try again.'
  })
