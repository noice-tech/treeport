ALTER TABLE `web_panel_storage` RENAME TO `__old_web_panel_storage`;
--> statement-breakpoint
ALTER TABLE `web_panels` RENAME TO `__old_web_panels`;
--> statement-breakpoint
ALTER TABLE `operations` RENAME TO `__old_operations`;
--> statement-breakpoint
ALTER TABLE `worktrees` RENAME TO `__old_worktrees`;
--> statement-breakpoint
CREATE TABLE `worktrees` (
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
	CONSTRAINT "worktrees_kind_check" CHECK("worktrees"."kind" IN ('main','linked'))
);
--> statement-breakpoint
INSERT INTO `worktrees`(
	`id`,`project_id`,`path`,`git_worktree_key`,`head`,`branch`,`detached`,`locked`,
	`lock_reason`,`prunable`,`kind`,`tmux_socket_name`,`managed_wrapper_path`,
	`pr_state`,`pr_number`,`pr_url`,`pr_base_branch`,`pr_head_branch`,`pr_merged_at`,
	`pr_refreshed_at`,`created_at`,`updated_at`
)
SELECT
	`id`,`project_id`,`path`,`git_worktree_key`,`head`,`branch`,`detached`,`locked`,
	`lock_reason`,`prunable`,`kind`,`tmux_socket_name`,`managed_wrapper_path`,
	`pr_state`,`pr_number`,`pr_url`,`pr_base_branch`,`pr_head_branch`,`pr_merged_at`,
	`pr_refreshed_at`,`created_at`,`updated_at`
FROM `__old_worktrees`;
--> statement-breakpoint
CREATE TABLE `web_panels` (
	`id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `web_panels` SELECT p.* FROM `__old_web_panels` p INNER JOIN `worktrees` w ON w.`id` = p.`worktree_id`;
--> statement-breakpoint
CREATE TABLE `web_panel_storage` (
	`panel_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`panel_id`) REFERENCES `web_panels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `web_panel_storage` SELECT s.* FROM `__old_web_panel_storage` s INNER JOIN `web_panels` p ON p.`id` = s.`panel_id`;
--> statement-breakpoint
CREATE TABLE `operations` (
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
	CONSTRAINT "operations_kind_check" CHECK("operations"."kind" IN ('create','finish','discard','project_cleanup','remove','external_remove')),
	CONSTRAINT "operations_status_check" CHECK("operations"."status" IN ('pending','running','completed','failed'))
);
--> statement-breakpoint
INSERT INTO `operations`(
	`id`,`kind`,`project_id`,`worktree_id`,`status`,`request_json`,`result_json`,`error`,`created_at`,`updated_at`
)
SELECT
	o.`id`,o.`kind`,o.`project_id`,w.`id`,o.`status`,o.`request_json`,o.`result_json`,o.`error`,o.`created_at`,o.`updated_at`
FROM `__old_operations` o LEFT JOIN `worktrees` w ON w.`id` = o.`worktree_id`;
--> statement-breakpoint
DROP TABLE `__old_web_panel_storage`;
--> statement-breakpoint
DROP TABLE `__old_web_panels`;
--> statement-breakpoint
DROP TABLE `__old_operations`;
--> statement-breakpoint
DROP TABLE `__old_worktrees`;
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_tmux_socket_name_unique` ON `worktrees` (`tmux_socket_name`);
--> statement-breakpoint
CREATE INDEX `worktrees_project_idx` ON `worktrees` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_git_key_idx` ON `worktrees` (`project_id`,`git_worktree_key`) WHERE "worktrees"."git_worktree_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `web_panels_worktree_order_idx` ON `web_panels` (`worktree_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_panel_storage_panel_key_idx` ON `web_panel_storage` (`panel_id`,`key`);
--> statement-breakpoint
CREATE INDEX `operations_worktree_idx` ON `operations` (`worktree_id`);
--> statement-breakpoint
CREATE INDEX `operations_project_kind_status_idx` ON `operations` (`project_id`,`kind`,`status`);
