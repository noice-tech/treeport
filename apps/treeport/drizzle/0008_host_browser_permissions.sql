CREATE TABLE IF NOT EXISTS `web_panel_permission_grants` (
	`source_key` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`permissions_json` text NOT NULL,
	`granted_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `web_panel_permission_definition_idx` ON `web_panel_permission_grants` (`definition_id`);
