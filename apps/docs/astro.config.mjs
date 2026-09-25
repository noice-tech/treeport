import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://treeport.app',
  integrations: [
    starlight({
      title: 'Treeport',
      description: 'Use persistent terminals in Git worktrees.',
      favicon: '/favicon.svg',
      disable404Route: true,
      head: [
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://treeport.app/social-card.png'
          }
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:alt',
            content: 'Treeport: Persistent terminals for Git worktrees.'
          }
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image',
            content: 'https://treeport.app/social-card.png'
          }
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image:alt',
            content: 'Treeport: Persistent terminals for Git worktrees.'
          }
        }
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/noice-tech/treeport'
        }
      ],
      editLink: {
        baseUrl: 'https://github.com/noice-tech/treeport/edit/main/apps/docs/'
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Install Treeport', slug: 'getting-started/installation' },
            {
              label: 'Projects, trees, and terminals',
              slug: 'concepts/projects-worktrees-terminals'
            }
          ]
        },
        {
          label: 'Features',
          items: [
            { label: 'Coding agents', slug: 'building-apps/coding-agents' },
            {
              label: 'Persistent terminals',
              slug: 'features/persistent-terminals'
            },
            { label: 'Terminal presets', slug: 'features/terminal-presets' },
            { label: 'Packages', slug: 'features/packages' },
            {
              label: 'Service supervision',
              slug: 'features/service-supervision'
            },
            { label: 'Remote access', slug: 'features/remote-access' },
            {
              label: 'Web panels (experimental)',
              slug: 'features/web-panels'
            },
            {
              label: 'Browser (experimental)',
              slug: 'features/browser-panel'
            },
            {
              label: 'Tree setup and cleanup',
              slug: 'features/worktree-setup-hooks'
            }
          ]
        }
      ]
    })
  ]
})
