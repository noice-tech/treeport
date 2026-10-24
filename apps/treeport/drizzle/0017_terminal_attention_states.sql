PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `terminal_attention_states` (
	`terminal_id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`reason` text NOT NULL,
	`unread` integer NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "terminal_attention_states_sequence_check" CHECK("terminal_attention_states"."sequence" > 0),
	CONSTRAINT "terminal_attention_states_reason_check" CHECK("terminal_attention_states"."reason" IN ('bell','done','blocked','error')),
	CONSTRAINT "terminal_attention_states_unread_check" CHECK("terminal_attention_states"."unread" IN (0,1))
);
--> statement-breakpoint
INSERT INTO `terminal_attention_states`("terminal_id", "worktree_id", "sequence", "occurred_at", "reason", "unread") SELECT "terminal_id", "worktree_id", "sequence", "occurred_at", 'bell', "unread" FROM `terminal_bell_states`;--> statement-breakpoint
DROP TABLE `terminal_bell_states`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
