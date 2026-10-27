import { createRoot } from 'react-dom/client'
import { App } from './app'
import attentionSoundUrl from './attention.wav'
import { ShellStateProvider } from './shell-state'
import './styles.css'

const attentionSoundGain = 0.35
let audio: AudioContext | null = null
let attentionSound: Promise<AudioBuffer> | null = null

window.treeportShell.onAttentionSound(() => {
  audio ??= new AudioContext()
  const context = audio
  attentionSound ??= fetch(attentionSoundUrl)
    .then((response) => response.arrayBuffer())
    .then((data) => context.decodeAudioData(data))

  void attentionSound.then((buffer) => {
    const source = context.createBufferSource()
    const gain = new GainNode(context, { gain: attentionSoundGain })
    source.buffer = buffer
    source.connect(gain).connect(context.destination)
    source.start()
  })
})

const root = document.querySelector<HTMLDivElement>('#app')

if (!root) {
  throw new Error('Missing desktop shell root')
}

createRoot(root).render(
  <ShellStateProvider>
    <App />
  </ShellStateProvider>
)
