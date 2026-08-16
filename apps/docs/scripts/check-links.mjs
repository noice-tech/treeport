import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const docsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const publicContentDirectory = path.join(docsDirectory, 'src/content/docs')
const internalContentDirectory = path.join(docsDirectory, 'internal')
const errors = []

const markdownFiles = []
for (const root of [publicContentDirectory, internalContentDirectory]) {
  const directories = [root]
  while (directories.length > 0) {
    const directory = directories.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        directories.push(entryPath)
      } else if (/\.mdx?$/.test(entry.name)) {
        markdownFiles.push(entryPath)
      }
    }
  }
}

function getAnchors(content) {
  const anchors = new Set()
  const occurrences = new Map()
  let inFence = false

  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }

    if (inFence) {
      continue
    }

    for (const match of line.matchAll(/\bid=["']([^"']+)["']/g)) {
      anchors.add(match[1])
    }

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)

    if (!match) {
      continue
    }

    const base = match[2]
      .replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')

    const occurrence = occurrences.get(base) ?? 0
    occurrences.set(base, occurrence + 1)
    anchors.add(occurrence === 0 ? base : `${base}-${occurrence}`)
  }

  return anchors
}

const pages = new Map()
for (const file of markdownFiles.filter((file) =>
  file.startsWith(publicContentDirectory)
)) {
  const relativePath = path.relative(publicContentDirectory, file)
  const withoutExtension = relativePath.replace(/\.mdx?$/, '')
  const route =
    withoutExtension === 'index'
      ? '/'
      : withoutExtension === '404'
        ? '/404.html'
        : `/${withoutExtension}/`
  const page = {
    file,
    route,
    anchors: getAnchors(fs.readFileSync(file, 'utf8'))
  }
  pages.set(route, page)
  pages.set(route.endsWith('/') ? route.slice(0, -1) || '/' : route, page)
}

function validatePublicTarget(sourceFile, sourceRoute, target) {
  const resolved = new URL(target, `https://treeport.app${sourceRoute}`)
  const route = decodeURIComponent(resolved.pathname)
  const page = pages.get(route)

  if (!page) {
    const staticFile = path.join(docsDirectory, 'public', route.slice(1))
    if (!fs.existsSync(staticFile)) {
      errors.push(
        `${path.relative(docsDirectory, sourceFile)}: missing route ${route}`
      )
    }

    return
  }

  if (resolved.hash) {
    const anchor = decodeURIComponent(resolved.hash.slice(1))
    if (!page.anchors.has(anchor)) {
      errors.push(
        `${path.relative(docsDirectory, sourceFile)}: missing anchor ${resolved.hash} on ${route}`
      )
    }
  }
}

const markdownLinkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g
for (const file of markdownFiles) {
  const content = fs.readFileSync(file, 'utf8')
  let match

  while ((match = markdownLinkPattern.exec(content)) !== null) {
    const target = match[1].replace(/^<|>$/g, '')

    if (/^(?:https?:|mailto:)/.test(target)) {
      continue
    }

    if (file.startsWith(publicContentDirectory)) {
      const relativePath = path.relative(publicContentDirectory, file)
      const withoutExtension = relativePath.replace(/\.mdx?$/, '')
      const sourceRoute =
        withoutExtension === 'index' ? '/' : `/${withoutExtension}/`
      validatePublicTarget(file, sourceRoute, target)
      continue
    }

    const [relativeTarget, hash = ''] = target.split('#')
    const targetFile = relativeTarget
      ? path.resolve(path.dirname(file), decodeURIComponent(relativeTarget))
      : file
    if (!fs.existsSync(targetFile)) {
      errors.push(
        `${path.relative(docsDirectory, file)}: missing file ${relativeTarget}`
      )
      continue
    }

    if (hash && /\.mdx?$/.test(targetFile)) {
      const anchors = getAnchors(fs.readFileSync(targetFile, 'utf8'))
      if (!anchors.has(decodeURIComponent(hash))) {
        errors.push(
          `${path.relative(docsDirectory, file)}: missing anchor #${hash} in ${relativeTarget || path.basename(file)}`
        )
      }
    }
  }
}

const redirectsPath = path.join(docsDirectory, 'public/_redirects')
for (const line of fs.readFileSync(redirectsPath, 'utf8').split('\n')) {
  const trimmed = line.trim()

  if (!trimmed || trimmed.startsWith('#')) {
    continue
  }

  const [, target] = trimmed.split(/\s+/)

  if (target?.startsWith('/')) {
    validatePublicTarget(redirectsPath, '/', target)
  }
}

if (errors.length > 0) {
  console.error(`Documentation link check failed:\n${errors.join('\n')}`)
  process.exit(1)
}

console.log(
  `Documentation link check passed for ${markdownFiles.length} Markdown files.`
)
