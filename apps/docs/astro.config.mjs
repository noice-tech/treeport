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
      logo: {
        light: './src/assets/icon.svg',
        dark: './src/assets/icon-dark.svg'
      },
      disable404Route: true,
      head: [
        {
          tag: 'link',
          attrs: { rel: 'stylesheet', href: 'https://rsms.me/inter/inter.css' }
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,300..500,100,0;1,9..144,300..500,100,0&family=JetBrains+Mono:wght@400;500&display=swap'
          }
        },
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
              label: 'Change Treeport',
              slug: 'getting-started/change-treeport'
            },
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
              label: 'Always on',
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
