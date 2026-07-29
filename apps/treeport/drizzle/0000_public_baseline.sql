CREATE TABLE IF NOT EXISTS `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`worktree_id` text,
	`status` text NOT NULL,
	`request_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "operations_kind_check" CHECK("operations"."kind" IN ('finish','discard','project_cleanup','remove','external_remove')),
	CONSTRAINT "operations_status_check" CHECK("operations"."status" IN ('pending','running','completed','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operations_worktree_idx` ON `operations` (`worktree_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repository_path` text NOT NULL,
	`main_worktree_path` text NOT NULL,
	`default_branch` text NOT NULL,
	`color` text,
	`repository_device` text NOT NULL,
	`repository_inode` text NOT NULL,
	`name_is_custom` integer DEFAULT 0 NOT NULL,
	`is_open` integer DEFAULT 1 NOT NULL,
	`last_opened_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "projects_color_check" CHECK("projects"."color" IS NULL OR "projects"."color" IN ('rose','orange','amber','emerald','cyan','blue','violet','pink')),
	CONSTRAINT "projects_name_is_custom_check" CHECK("projects"."name_is_custom" IN (0,1)),
	CONSTRAINT "projects_is_open_check" CHECK("projects"."is_open" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `projects_repository_path_unique` ON `projects` (`repository_path`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `projects_fs_identity_idx` ON `projects` (`repository_device`,`repository_inode`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `projects_recent_idx` ON `projects` (`is_open`,"last_opened_at" desc,`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `terminal_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`executable` text NOT NULL,
	`args_json` text NOT NULL,
	`close_on_success` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "terminal_presets_close_on_success_check" CHECK("terminal_presets"."close_on_success" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `terminal_presets_order_idx` ON `terminal_presets` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`git_worktree_key` text,
	`head` text DEFAULT '' NOT NULL,
	`branch` text,
	`detached` integer DEFAULT 0 NOT NULL,
	`locked` integer DEFAULT 0 NOT NULL,
	`lock_reason` text,
	`prunable` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	`tmux_socket_name` text NOT NULL,
	`status` text NOT NULL,
	`cleanup_error` text,
	`managed_wrapper_path` text,
	`pr_state` text DEFAULT 'unknown' NOT NULL,
	`pr_number` integer,
	`pr_url` text,
	`pr_base_branch` text,
	`pr_head_branch` text,
	`pr_merged_at` text,
	`pr_refreshed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "worktrees_detached_check" CHECK("worktrees"."detached" IN (0,1)),
	CONSTRAINT "worktrees_locked_check" CHECK("worktrees"."locked" IN (0,1)),
	CONSTRAINT "worktrees_prunable_check" CHECK("worktrees"."prunable" IN (0,1)),
	CONSTRAINT "worktrees_kind_check" CHECK("worktrees"."kind" IN ('main','linked')),
	CONSTRAINT "worktrees_status_check" CHECK("worktrees"."status" IN ('active','cleaning','cleanup_failed','removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `worktrees_path_unique` ON `worktrees` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `worktrees_tmux_socket_name_unique` ON `worktrees` (`tmux_socket_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `worktrees_project_idx` ON `worktrees` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `worktrees_git_key_idx` ON `worktrees` (`project_id`,`git_worktree_key`) WHERE "worktrees"."git_worktree_key" IS NOT NULL;