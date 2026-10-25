import { treeport } from '@treeport/app-sdk'
import './editor.css'

const status = document.querySelector<HTMLParagraphElement>('#status')!
const retry = document.querySelector<HTMLButtonElement>('#retry')!
const output = document.querySelector<HTMLDetailsElement>('#output')!
const logs = document.querySelector<HTMLPreElement>('#logs')!

function openEditor() {
  retry.hidden = true
  output.hidden = true
  status.setAttribute('role', 'status')
  status.textContent = 'Starting the shared code-server service…'
  void treeport.services
    .ensure('code-server')
    .then((service) => {
      if (!service.url) {
        throw new Error(service.error ?? 'Service is not ready')
      }

      window.location.replace(service.url)
    })
    .catch(async (error) => {
      status.setAttribute('role', 'alert')
      status.textContent =
        error instanceof Error ? error.message : String(error)
      retry.hidden = false

      const service = await treeport.services
        .status('code-server')
        .catch(() => null)

      logs.textContent = service?.logs ?? ''
      output.hidden = !service?.logs
    })
}

retry.addEventListener('click', openEditor)

openEditor()
