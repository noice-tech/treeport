CREATE TABLE `browser_panels` (
	`id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `browser_panels_worktree_order_idx` ON `browser_panels` (`worktree_id`,`created_at`,`id`);