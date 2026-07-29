import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  integrations: [
    starlight({
      title: 'Treeport',
      description:
        'A worktree-first terminal driver for persistent development workspaces.',
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
            {
              label: 'Projects, worktrees, and terminals',
              slug: 'concepts/projects-worktrees-terminals'
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
            {
              label: 'Worktree setup hooks',
              slug: 'features/worktree-setup-hooks'
            }
          ]
        },
        {
          label: 'Guides',
          items: [
            {
              label: 'Removing a worktree',
              slug: 'guides/removing-a-worktree'
            },
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
