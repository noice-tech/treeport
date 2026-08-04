DROP INDEX `projects_fs_identity_idx`;--> statement-breakpoint
ALTER TABLE `projects` ADD `repository_identity` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repository_identity_idx` ON `projects` (`repository_identity`) WHERE "projects"."repository_identity" IS NOT NULL;