PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repository_path` text NOT NULL,
	`main_worktree_path` text NOT NULL,
	`default_branch` text NOT NULL,
	`repository_device` text NOT NULL,
	`repository_inode` text NOT NULL,
	`name_is_custom` integer DEFAULT 0 NOT NULL,
	`is_open` integer DEFAULT 1 NOT NULL,
	`last_opened_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`repository_identity` text,
	`show_in_recents` integer DEFAULT 0 NOT NULL CONSTRAINT "projects_show_in_recents_check" CHECK(`show_in_recents` IN (0,1)),
	`project_kind` text DEFAULT 'repository' NOT NULL CONSTRAINT `projects_kind_check` CHECK(`project_kind` IN ('repository','folder')),
	`origin_url` text,
	`is_home` integer DEFAULT 0 NOT NULL CHECK (`is_home` IN (0,1)),
	CONSTRAINT "projects_name_is_custom_check" CHECK(`name_is_custom` IN (0,1)),
	CONSTRAINT "projects_is_open_check" CHECK(`is_open` IN (0,1))
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "name", "project_kind", "repository_path", "main_worktree_path", "default_branch", "origin_url", "repository_identity", "repository_device", "repository_inode", "name_is_custom", "is_open", "is_home", "show_in_recents", "last_opened_at", "created_at", "updated_at") SELECT "id", "name", "project_kind", "repository_path", "main_worktree_path", "default_branch", "origin_url", "repository_identity", "repository_device", "repository_inode", "name_is_custom", "is_open", "is_home", "show_in_recents", "last_opened_at", "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repository_path_unique` ON `projects` (`repository_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_home_idx` ON `projects` (`is_home`) WHERE "projects"."is_home" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repository_identity_idx` ON `projects` (`repository_identity`) WHERE "projects"."repository_identity" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `projects_recent_idx` ON `projects` (`is_open`,`show_in_recents`,`last_opened_at` DESC,`id`);