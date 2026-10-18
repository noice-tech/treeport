import type { WebAppPermission } from '@treeport/shared'

export function describeWebAppPermissions(
  permissions: WebAppPermission[]
): string {
  return permissions
    .map((permission) =>
      permission === 'same-origin'
        ? "It will share Treeport's web origin. It can access Treeport browser storage, the Treeport page, and API routes available to this client."
        : 'It can read and change existing files in this tree.'
    )
    .join(' ')
}
