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
            { label: 'Install Treeport', slug: 'getting-started/installation' }
          ]
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Design principles', slug: 'concepts/philosophy' },
            {
              label: 'Projects, trees, and terminals',
              slug: 'concepts/projects-worktrees-terminals'
            },
            {
              label: 'Fits around your tools',
              slug: 'concepts/fits-around-your-tools'
            }
          ]
        },
        {
          label: 'Features',
          items: [
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
              label: 'Browser panel (experimental)',
              slug: 'features/browser-panel'
            },
            {
              label: 'Attention and progress',
              slug: 'features/attention-and-progress'
            },
            {
              label: 'Tree setup',
              slug: 'features/worktree-setup-hooks'
            }
          ]
        },
        {
          label: 'Tools and workflows',
          items: [
            {
              label: 'Tree-friendly development',
              slug: 'workflows/worktree-friendly-development'
            },
            { label: 'Shell setup', slug: 'workflows/shell-setup' },
            { label: 'Coding agents', slug: 'building-apps/coding-agents' }
          ]
        },
        {
          label: 'Reference',
          items: [
            { label: 'Shortcuts', slug: 'reference/shortcuts' },
            { label: 'CLI', slug: 'reference/cli' },
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'Terminal signals', slug: 'reference/terminal-signals' }
          ]
        },
        { label: 'Security', slug: 'security' }
      ]
    })
  ]
})
