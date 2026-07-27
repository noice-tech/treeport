import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  integrations: [
    starlight({
      title: 'Treeport',
      description:
        'A worktree-first terminal driver for persistent development workspaces.',
      logo: {
        src: './src/assets/treeport-mark.svg',
        alt: 'Treeport'
      },
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
              label: 'Your first workspace',
              slug: 'getting-started/first-workspace'
            }
          ]
        },
        {
          label: 'Concepts',
          items: [
            {
              label: 'Worktree-first development',
              slug: 'concepts/worktree-first'
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
            { label: 'Web, mobile, and desktop', slug: 'features/interfaces' },
            { label: 'Safe worktree cleanup', slug: 'features/safe-cleanup' }
          ]
        },
        {
          label: 'Guides',
          items: [
            { label: 'Coding-agent workflows', slug: 'guides/agent-workflows' },
            {
              label: 'Private-network access',
              slug: 'guides/private-network-access'
            }
          ]
        },
        {
          label: 'Reference',
          items: [
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
