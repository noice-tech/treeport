ALTER TABLE `terminal_presets` ADD `tree_title_json` text;--> statement-breakpoint
ALTER TABLE `worktrees` DROP COLUMN `tree_context_json`;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `title` text;