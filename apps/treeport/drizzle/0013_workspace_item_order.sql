CREATE TABLE `workspace_item_orders` (
	`worktree_id` text NOT NULL,
	`surface` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_item_orders_surface_check" CHECK("workspace_item_orders"."surface" IN ('terminal','tool')),
	CONSTRAINT "workspace_item_orders_position_check" CHECK("workspace_item_orders"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_item_orders_item_idx` ON `workspace_item_orders` (`surface`,`item_id`);
--> statement-breakpoint
CREATE INDEX `workspace_item_orders_worktree_idx` ON `workspace_item_orders` (`worktree_id`,`surface`,`position`);
