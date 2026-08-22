ALTER TABLE `projects` ADD `project_kind` text DEFAULT 'repository' NOT NULL CONSTRAINT `projects_kind_check` CHECK(`project_kind` IN ('repository','folder'));
--> statement-breakpoint
ALTER TABLE `web_panel_storage` RENAME TO `__old_open_folders_web_panel_storage`;
--> statement-breakpoint
ALTER TABLE `web_panels` RENAME TO `__old_open_folders_web_panels`;
--> statement-breakpoint
ALTER TABLE `terminal_bell_states` RENAME TO `__old_open_folders_terminal_bell_states`;
--> statement-breakpoint
ALTER TABLE `operations` RENAME TO `__old_open_folders_operations`;
--> statement-breakpoint
ALTER TABLE `worktrees` RENAME TO `__old_open_folders_worktrees`;
--> statement-breakpoint
DROP INDEX `web_panel_storage_panel_key_idx`;
--> statement-breakpoint
DROP INDEX `web_panels_worktree_order_idx`;
--> statement-breakpoint
DROP INDEX `operations_worktree_idx`;
--> statement-breakpoint
DROP INDEX `operations_project_kind_status_idx`;
--> statement-breakpoint
DROP INDEX `worktrees_path_unique`;
--> statement-breakpoint
DROP INDEX `worktrees_tmux_socket_name_unique`;
--> statement-breakpoint
DROP INDEX `worktrees_project_idx`;
--> statement-breakpoint
DROP INDEX `worktrees_git_key_idx`;
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
  CONSTRAINT `worktrees_detached_check` CHECK(`detached` IN (0,1)),
  CONSTRAINT `worktrees_locked_check` CHECK(`locked` IN (0,1)),
  CONSTRAINT `worktrees_prunable_check` CHECK(`prunable` IN (0,1)),
  CONSTRAINT `worktrees_kind_check` CHECK(`kind` IN ('main','linked','folder'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_tmux_socket_name_unique` ON `worktrees` (`tmux_socket_name`);
--> statement-breakpoint
CREATE INDEX `worktrees_project_idx` ON `worktrees` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_git_key_idx` ON `worktrees` (`project_id`,`git_worktree_key`) WHERE `git_worktree_key` IS NOT NULL;
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
  CONSTRAINT `operations_kind_check` CHECK(`kind` IN ('create','finish','discard','project_cleanup','remove','external_remove')),
  CONSTRAINT `operations_status_check` CHECK(`status` IN ('pending','running','completed','failed'))
);
--> statement-breakpoint
CREATE INDEX `operations_worktree_idx` ON `operations` (`worktree_id`);
--> statement-breakpoint
CREATE INDEX `operations_project_kind_status_idx` ON `operations` (`project_id`,`kind`,`status`);
--> statement-breakpoint
CREATE TABLE `web_panels` (
  `id` text PRIMARY KEY NOT NULL,
  `worktree_id` text NOT NULL,
  `definition_id` text NOT NULL,
  `title` text NOT NULL,
  `input_json` text DEFAULT 'null' NOT NULL,
  `launch_cwd` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `web_panels_worktree_order_idx` ON `web_panels` (`worktree_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `web_panel_storage` (
  `panel_id` text NOT NULL,
  `key` text NOT NULL,
  `value_json` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`panel_id`) REFERENCES `web_panels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_panel_storage_panel_key_idx` ON `web_panel_storage` (`panel_id`,`key`);
--> statement-breakpoint
CREATE TABLE `terminal_bell_states` (
  `terminal_id` text PRIMARY KEY NOT NULL,
  `worktree_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `occurred_at` text NOT NULL,
  `unread` integer NOT NULL,
  FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
  CONSTRAINT `terminal_bell_states_sequence_check` CHECK(`sequence` > 0),
  CONSTRAINT `terminal_bell_states_unread_check` CHECK(`unread` IN (0,1))
);
--> statement-breakpoint
INSERT INTO `worktrees` SELECT * FROM `__old_open_folders_worktrees`;
--> statement-breakpoint
INSERT INTO `operations` SELECT * FROM `__old_open_folders_operations`;
--> statement-breakpoint
INSERT INTO `web_panels`(
  `id`,`worktree_id`,`definition_id`,`title`,`input_json`,`launch_cwd`,
  `created_at`,`updated_at`
)
SELECT
  `id`,`worktree_id`,`definition_id`,`title`,`input_json`,`launch_cwd`,
  `created_at`,`updated_at`
FROM `__old_open_folders_web_panels`;
--> statement-breakpoint
INSERT INTO `web_panel_storage` SELECT * FROM `__old_open_folders_web_panel_storage`;
--> statement-breakpoint
INSERT INTO `terminal_bell_states` SELECT * FROM `__old_open_folders_terminal_bell_states`;
--> statement-breakpoint
DROP TABLE `__old_open_folders_web_panel_storage`;
--> statement-breakpoint
DROP TABLE `__old_open_folders_web_panels`;
--> statement-breakpoint
DROP TABLE `__old_open_folders_terminal_bell_states`;
--> statement-breakpoint
DROP TABLE `__old_open_folders_operations`;
--> statement-breakpoint
DROP TABLE `__old_open_folders_worktrees`;
