CREATE TABLE `terminal_bell_states` (
	`terminal_id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`unread` integer NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "terminal_bell_states_sequence_check" CHECK("terminal_bell_states"."sequence" > 0),
	CONSTRAINT "terminal_bell_states_unread_check" CHECK("terminal_bell_states"."unread" IN (0,1))
);
