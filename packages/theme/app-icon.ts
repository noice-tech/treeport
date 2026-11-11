const MACOS_TILE_824_WITH_100_MARGIN =
  'M628 100 c103.6097 0 155.4146 0 194.9882 20.1638 a185 185 0 0 1 80.848 80.848 c20.1638 39.5737 20.1638 91.3785 20.1638 194.9882 V628 c0 103.6097 0 155.4146 -20.1638 194.9882 a185 185 0 0 1 -80.848 80.848 c-39.5737 20.1638 -91.3785 20.1638 -194.9882 20.1638 H396 c-103.6097 0 -155.4146 0 -194.9882 -20.1638 a185 185 0 0 1 -80.848 -80.848 C100 783.4146 100 731.6097 100 628 V396 c0 -103.6097 0 -155.4146 20.1638 -194.9882 a185 185 0 0 1 80.848 -80.848 C240.5854 100 292.3903 100 396 100 Z'

const FAVICON_TILE =
  'M200 100H824A100 100 0 0 1 924 200V824A100 100 0 0 1 824 924H200A100 100 0 0 1 100 824V200A100 100 0 0 1 200 100Z'

const PINE_GRID_TO_TILE = 'translate(188 196) scale(27)'
const TOP_TIER = 'M12 3L5.5 11.5h13Z'
const BOTTOM_TIER = 'M12 7.5L3.5 18.5h17Z'
const TRUNK = 'M10.6 18h2.8v3.2a.9.9 0 0 1-.9.9h-1a.9.9 0 0 1-.9-.9Z'

export const DEFAULT_ACCENT = '#6ccefe'

function mix(color: string, target: string, amount: number) {
  const channel = (hex: string, index: number) =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)

  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(
        channel(color, index) +
          (channel(target, index) - channel(color, index)) * amount
      )
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

export function appIconSvg({
  accent,
  mode,
  badge,
  framing
}: {
  accent: string
  mode: 'dark' | 'light'
  badge: boolean
  framing: 'dock' | 'favicon'
}) {
  const dark = mode === 'dark'
  const dock = framing === 'dock'
  const tile = dock ? MACOS_TILE_824_WITH_100_MARGIN : FAVICON_TILE

  const pinePath = (d: string, attributes: string) =>
    `<path d="${d}" transform="${PINE_GRID_TO_TILE}" ${attributes}/>`

  const tier = (d: string, fill: string, clip: string) => `
<g filter="url(#tier-shadow)">${pinePath(d, `fill="${dark ? '#000000' : mix(accent, '#000000', 0.7)}" stroke="${dark ? '#000000' : mix(accent, '#000000', 0.7)}" stroke-width=".9" stroke-linejoin="round"`)}</g>
${pinePath(d, `fill="url(#${fill})" stroke="url(#${fill})" stroke-width=".9" stroke-linejoin="round"`)}
<g clip-path="url(#${clip})">${pinePath(d, 'fill="url(#sheen)"')}</g>
${pinePath(d, 'fill="none" stroke="url(#rim)" stroke-width=".42" stroke-linejoin="round"')}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${dock ? '0 0 1024 1024' : '100 100 824 824'}" width="1024" height="1024"><defs>
<clipPath id="tile"><path d="${tile}"/></clipPath>
<clipPath id="top-clip">${pinePath(TOP_TIER, '')}</clipPath>
<clipPath id="bottom-clip">${pinePath(BOTTOM_TIER, '')}</clipPath>
<filter id="drop" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur in="SourceAlpha" stdDeviation="6"/><feOffset dy="6"/><feComponentTransfer><feFuncA type="linear" slope=".18"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="tier-shadow" x="-30%" y="-30%" width="160%" height="170%"><feGaussianBlur stdDeviation="3"/><feOffset dy="5"/><feComponentTransfer><feFuncA type="linear" slope="${dark ? 0.3 : 0.12}"/></feComponentTransfer></filter>
<linearGradient id="background" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dark ? mix('#16181d', accent, 0.16) : mix('#ffffff', accent, 0.06)}"/><stop offset="1" stop-color="${dark ? '#08090b' : mix('#e4e7ec', accent, 0.1)}"/></linearGradient>
<radialGradient id="glare" cx=".5" cy="0" r=".9"><stop offset="0" stop-color="#ffffff" stop-opacity="${dark ? 0.06 : 0.5}"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<linearGradient id="front" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(accent, '#ffffff', 0.45)}"/><stop offset=".55" stop-color="${accent}"/><stop offset="1" stop-color="${mix(accent, '#000000', 0.18)}"/></linearGradient>
<linearGradient id="back" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(accent, '#ffffff', 0.25)}"/><stop offset=".6" stop-color="${mix(accent, '#000000', 0.12)}"/><stop offset="1" stop-color="${mix(accent, '#000000', 0.38)}"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset=".38" stop-color="#ffffff" stop-opacity=".06"/><stop offset=".4" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".95"/><stop offset=".45" stop-color="#ffffff" stop-opacity=".1"/><stop offset="1" stop-color="#ffffff" stop-opacity=".45"/></linearGradient>
<linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="${dark ? 0.45 : 0.95}"/><stop offset=".4" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#ffffff" stop-opacity="${dark ? 0.15 : 0.5}"/></linearGradient>
<linearGradient id="trunk" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${mix(accent, dark ? '#ffffff' : '#000000', dark ? 0.55 : 0.45)}"/><stop offset="1" stop-color="${mix(accent, '#000000', dark ? 0.25 : 0.6)}"/></linearGradient>
</defs>
<g${dock ? ' filter="url(#drop)"' : ''}><g clip-path="url(#tile)">
<rect width="1024" height="1024" fill="url(#background)"/><rect width="1024" height="1024" fill="url(#glare)"/>
${pinePath(TRUNK, 'fill="url(#trunk)"')}
${tier(BOTTOM_TIER, 'back', 'bottom-clip')}
${tier(TOP_TIER, 'front', 'top-clip')}
</g><path d="${tile}" fill="none" stroke="url(#edge)" stroke-width="4"/></g>${
    badge
      ? `
<rect x="530" y="736" width="324" height="132" rx="36" fill="#fbbf24"/>
<!-- Outlined DEV lettering keeps the badge independent of installed fonts. -->
<g fill="#18181b"><path fill-rule="evenodd" d="M584 766h29c27 0 41 14 41 37s-14 37-41 37h-29zm18 16v42h10c16 0 24-7 24-21s-8-21-24-21z"/><path d="M669 766h54v16h-36v13h32v16h-32v13h36v16h-54z"/><path d="M735 766h20l17 51 17-51h20l-27 74h-20z"/></g>`
      : ''
  }</svg>`
}

export function appIconDataUrl(
  theme: { mode: 'auto' | 'dark' | 'light'; accent: string | null },
  { badge, framing }: { badge: boolean; framing: 'dock' | 'favicon' }
) {
  const systemMode = window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    appIconSvg({
      accent: theme.accent ?? DEFAULT_ACCENT,
      mode: theme.mode === 'auto' ? systemMode : theme.mode,
      badge,
      framing
    })
  )}`
}
