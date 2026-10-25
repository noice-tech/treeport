ALTER TABLE `worktrees` RENAME COLUMN `badges` TO `decorations`;--> statement-breakpoint
UPDATE `worktrees` SET `decorations` = '{}';