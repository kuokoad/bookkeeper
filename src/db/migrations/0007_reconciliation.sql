CREATE TABLE `reconciliations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reconciliation_no` text NOT NULL,
	`payment_account_id` integer NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`expected_minor` integer NOT NULL,
	`actual_minor` integer NOT NULL,
	`difference_minor` integer NOT NULL,
	`explanation` text,
	`adjusted` integer DEFAULT false NOT NULL,
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
	CONSTRAINT "ck_reconciliations_status" CHECK("reconciliations"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_reconciliations_date_format" CHECK("reconciliations"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_reconciliations_difference" CHECK("reconciliations"."difference_minor" = "reconciliations"."actual_minor" - "reconciliations"."expected_minor"),
	CONSTRAINT "ck_reconciliations_explained" CHECK("reconciliations"."difference_minor" = 0 OR ("reconciliations"."explanation" IS NOT NULL AND length(trim("reconciliations"."explanation")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_reconciliations_no` ON `reconciliations` (`reconciliation_no`);--> statement-breakpoint
CREATE INDEX `idx_reconciliations_account` ON `reconciliations` (`payment_account_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_reconciliations_date` ON `reconciliations` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_reconciliations_status` ON `reconciliations` (`status`);