CREATE TABLE `owner_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`movement_no` text NOT NULL,
	`kind` text NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`payment_account_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'POSTED' NOT NULL,
	`journal_entry_id` integer,
	`voided_at` integer,
	`void_reason` text,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`payment_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_owner_movements_kind" CHECK("owner_movements"."kind" IN ('CAPITAL', 'DRAWINGS')),
	CONSTRAINT "ck_owner_movements_status" CHECK("owner_movements"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_owner_movements_amount_positive" CHECK("owner_movements"."amount_minor" > 0),
	CONSTRAINT "ck_owner_movements_date_format" CHECK("owner_movements"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_owner_movements_no` ON `owner_movements` (`movement_no`);--> statement-breakpoint
CREATE INDEX `idx_owner_movements_date` ON `owner_movements` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_owner_movements_kind` ON `owner_movements` (`kind`);