// Pixel contract with browser-stream-diagnostics.tsx. No clocks or timing
// results cross the input channel: only this changed image completes a probe.
const marker = document.querySelector('canvas').getContext('2d')
let counter = 0

const draw = () => {
  const word = (0xa69c << 16) | (counter << 8) | (counter ^ 255)

  for (let i = 0; i < 32; i++) {
    marker.fillStyle = (word >>> (31 - i)) & 1 ? '#fff' : '#000'
    marker.fillRect(i, 0, 1, 1)
  }

  document.querySelector('output').textContent = String(counter)
}

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.pointerType !== 'mouse') {
    return
  }

  counter = (counter + 1) & 255
  draw()
})

for (let i = 0; i < 100; i++) {
  const article = document.createElement('article')
  article.textContent = `Scrolling workload ${i + 1} — text and edges exercise capture and encoding while the fixed marker remains visible.`
  document.querySelector('main').append(article)
}

draw()
