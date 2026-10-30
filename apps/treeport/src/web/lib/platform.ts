export function isApplePlatform() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

export function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}
