ALTER TABLE `projects` ADD `is_home` integer DEFAULT 0 NOT NULL CHECK (`is_home` IN (0,1));--> statement-breakpoint
CREATE UNIQUE INDEX `projects_home_idx` ON `projects` (`is_home`) WHERE "projects"."is_home" = 1;
