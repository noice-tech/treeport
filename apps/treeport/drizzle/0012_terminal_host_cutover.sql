CREATE TABLE `__new_worktrees` (
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
	`managed_wrapper_path` text,
	`tree_context_json` text DEFAULT '{}' NOT NULL,
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
	CONSTRAINT "worktrees_detached_check" CHECK("__new_worktrees"."detached" IN (0,1)),
	CONSTRAINT "worktrees_locked_check" CHECK("__new_worktrees"."locked" IN (0,1)),
	CONSTRAINT "worktrees_prunable_check" CHECK("__new_worktrees"."prunable" IN (0,1)),
	CONSTRAINT "worktrees_kind_check" CHECK("__new_worktrees"."kind" IN ('main','linked','folder'))
);
--> statement-breakpoint
INSERT INTO `__new_worktrees`("id", "project_id", "path", "git_worktree_key", "head", "branch", "detached", "locked", "lock_reason", "prunable", "kind", "managed_wrapper_path", "tree_context_json", "pr_state", "pr_number", "pr_url", "pr_base_branch", "pr_head_branch", "pr_merged_at", "pr_refreshed_at", "created_at", "updated_at") SELECT "id", "project_id", "path", "git_worktree_key", "head", "branch", "detached", "locked", "lock_reason", "prunable", "kind", "managed_wrapper_path", "tree_context_json", "pr_state", "pr_number", "pr_url", "pr_base_branch", "pr_head_branch", "pr_merged_at", "pr_refreshed_at", "created_at", "updated_at" FROM `worktrees`;
--> statement-breakpoint
DROP TABLE `worktrees`;
--> statement-breakpoint
ALTER TABLE `__new_worktrees` RENAME TO `worktrees`;
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);
--> statement-breakpoint
CREATE INDEX `worktrees_project_idx` ON `worktrees` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_git_key_idx` ON `worktrees` (`project_id`,`git_worktree_key`) WHERE "worktrees"."git_worktree_key" IS NOT NULL;
