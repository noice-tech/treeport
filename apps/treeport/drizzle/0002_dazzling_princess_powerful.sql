CREATE TABLE `web_panel_storage` (
	`panel_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`panel_id`) REFERENCES `web_panels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_panel_storage_panel_key_idx` ON `web_panel_storage` (`panel_id`,`key`);