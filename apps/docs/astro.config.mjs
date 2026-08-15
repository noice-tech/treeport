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
            { label: 'Philosophy', slug: 'concepts/philosophy' },
            {
              label: 'Projects, worktrees, and terminals',
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
              label: 'Worktree setup',
              slug: 'features/worktree-setup-hooks'
            }
          ]
        },
        {
          label: 'Tools and workflows',
          items: [
            {
              label: 'Worktree-friendly development',
              slug: 'workflows/worktree-friendly-development'
            },
            { label: 'Shell setup', slug: 'workflows/shell-setup' },
            { label: 'Coding agents', slug: 'building-apps/coding-agents' },
            {
              label: 'Contributor development',
              slug: 'building-apps/contributing'
            }
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
