ALTER TABLE `browser_panels` RENAME TO `browser_apps`;
--> statement-breakpoint
ALTER TABLE `web_panels` RENAME TO `web_apps`;
--> statement-breakpoint
ALTER TABLE `web_panel_permission_grants` RENAME TO `web_app_permission_grants`;
--> statement-breakpoint
ALTER TABLE `web_panel_storage` RENAME TO `web_app_storage`;
--> statement-breakpoint
ALTER TABLE `web_app_storage` RENAME COLUMN `panel_id` TO `app_id`;
--> statement-breakpoint
DROP INDEX `browser_panels_worktree_order_idx`;
--> statement-breakpoint
CREATE INDEX `browser_apps_worktree_order_idx` ON `browser_apps` (`worktree_id`,`created_at`,`id`);
--> statement-breakpoint
DROP INDEX `web_panels_worktree_order_idx`;
--> statement-breakpoint
CREATE INDEX `web_apps_worktree_order_idx` ON `web_apps` (`worktree_id`,`created_at`,`id`);
--> statement-breakpoint
DROP INDEX `web_panel_permission_definition_idx`;
--> statement-breakpoint
CREATE INDEX `web_app_permission_definition_idx` ON `web_app_permission_grants` (`definition_id`);
--> statement-breakpoint
DROP INDEX `web_panel_storage_panel_key_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `web_app_storage_app_key_idx` ON `web_app_storage` (`app_id`,`key`);
--> statement-breakpoint
UPDATE `web_apps` SET `definition_id` = replace(`definition_id`, ':web-panel:', ':web-app:')
WHERE `definition_id` LIKE 'package:%:web-panel:%';
--> statement-breakpoint
-- Package grants hash the definition ID into their source key. Require fresh
-- consent for renamed package definitions rather than carrying stale grants.
DELETE FROM `web_app_permission_grants` WHERE `definition_id` LIKE 'package:%:web-panel:%';
