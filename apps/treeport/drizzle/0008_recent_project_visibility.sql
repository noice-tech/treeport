ALTER TABLE `projects` ADD `show_in_recents` integer DEFAULT 0 NOT NULL CONSTRAINT "projects_show_in_recents_check" CHECK(`show_in_recents` IN (0,1));--> statement-breakpoint
UPDATE `projects` SET `show_in_recents` = 1 WHERE `is_open` = 0;--> statement-breakpoint
DROP INDEX `projects_recent_idx`;--> statement-breakpoint
CREATE INDEX `projects_recent_idx` ON `projects` (`is_open`,`show_in_recents`,`last_opened_at` DESC,`id`);
