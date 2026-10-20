PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_web_app_storage` (
	`app_id` text,
	`definition_id` text,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `web_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "web_app_storage_owner_check" CHECK(("__new_web_app_storage"."app_id" IS NOT NULL AND "__new_web_app_storage"."definition_id" IS NULL) OR ("__new_web_app_storage"."app_id" IS NULL AND "__new_web_app_storage"."definition_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_web_app_storage`("app_id", "definition_id", "key", "value_json", "updated_at") SELECT "app_id", NULL, "key", "value_json", "updated_at" FROM `web_app_storage`;--> statement-breakpoint
DROP TABLE `web_app_storage`;--> statement-breakpoint
ALTER TABLE `__new_web_app_storage` RENAME TO `web_app_storage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `web_app_storage_app_key_idx` ON `web_app_storage` (`app_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `web_app_storage_definition_key_idx` ON `web_app_storage` (`definition_id`,`key`);