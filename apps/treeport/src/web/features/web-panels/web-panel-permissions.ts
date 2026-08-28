import type { WebPanelPermission } from '@treeport/shared'

export function describeWebPanelPermissions(
  permissions: WebPanelPermission[]
): string {
  return permissions
    .map((permission) =>
      permission === 'same-origin'
        ? "It will share Treeport's web origin. It can access Treeport browser storage, the Treeport page, and API routes available to this client."
        : 'It can read and change existing files in this tree.'
    )
    .join(' ')
}
