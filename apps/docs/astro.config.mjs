import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://treeport.app',
  integrations: [
    starlight({
      title: 'Treeport',
      description:
        'A workspace for coding agents, browsers, custom apps, and services.',
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
            content: 'Treeport: A place for your agents to work.'
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
            content: 'Treeport: A place for your agents to work.'
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
              label: 'Projects, trees, and apps',
              slug: 'concepts/projects-worktrees-terminals'
            }
          ]
        },
        {
          label: 'Features',
          items: [
            { label: 'Coding agents', slug: 'building-apps/coding-agents' },
            {
              label: 'Terminals',
              slug: 'features/persistent-terminals'
            },
            {
              label: 'Browser',
              slug: 'features/browser-app'
            },
            {
              label: 'Web apps',
              slug: 'features/web-apps'
            },
            { label: 'Packages', slug: 'features/packages' },
            { label: 'Launchers', slug: 'features/launchers' },
            { label: 'Remote access', slug: 'features/remote-access' },
            {
              label: 'Service supervision',
              slug: 'features/service-supervision'
            },
            {
              label: 'Tree setup and cleanup',
              slug: 'features/worktree-setup-hooks'
            }
          ]
        },
        {
          label: 'Reference',
          items: [
            {
              label: 'Project configuration',
              slug: 'reference/project-configuration'
            }
          ]
        }
      ]
    })
  ]
})
