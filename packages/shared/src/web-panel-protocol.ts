import { z } from 'zod'
import type { WebPanelPermission } from '@treeport/panel-sdk'

export const webPanelPermissionSchema: z.ZodType<WebPanelPermission> = z.enum([
  'same-origin',
  'tree-files'
])
