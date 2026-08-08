CREATE TABLE `__new_operations` (
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
	CONSTRAINT "operations_kind_check" CHECK("__new_operations"."kind" IN ('create','finish','discard','project_cleanup','remove','external_remove')),
	CONSTRAINT "operations_status_check" CHECK("__new_operations"."status" IN ('pending','running','completed','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_operations`("id", "kind", "project_id", "worktree_id", "status", "request_json", "result_json", "error", "created_at", "updated_at") SELECT "id", "kind", "project_id", "worktree_id", "status", "request_json", "result_json", "error", "created_at", "updated_at" FROM `operations`;
--> statement-breakpoint
DROP TABLE `operations`;
--> statement-breakpoint
ALTER TABLE `__new_operations` RENAME TO `operations`;
--> statement-breakpoint
CREATE INDEX `operations_worktree_idx` ON `operations` (`worktree_id`);
--> statement-breakpoint
CREATE INDEX `operations_project_kind_status_idx` ON `operations` (`project_id`,`kind`,`status`);
