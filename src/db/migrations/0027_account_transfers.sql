CREATE TABLE `account_transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transfer_no` text NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`from_account_id` integer NOT NULL,
	`to_account_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`reference` text,
	`note` text,
	`status` text DEFAULT 'POSTED' NOT NULL,
	`journal_entry_id` integer,
	`voided_at` integer,
	`void_reason` text,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`from_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`to_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_account_transfers_status" CHECK("account_transfers"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_account_transfers_amount_positive" CHECK("account_transfers"."amount_minor" > 0),
	CONSTRAINT "ck_account_transfers_distinct" CHECK("account_transfers"."from_account_id" <> "account_transfers"."to_account_id"),
	CONSTRAINT "ck_account_transfers_date_format" CHECK("account_transfers"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_account_transfers_no` ON `account_transfers` (`transfer_no`);--> statement-breakpoint
CREATE INDEX `idx_account_transfers_date` ON `account_transfers` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_account_transfers_from` ON `account_transfers` (`from_account_id`);--> statement-breakpoint
CREATE INDEX `idx_account_transfers_to` ON `account_transfers` (`to_account_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_no` text NOT NULL,
	`entry_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer,
	`memo` text,
	`is_opening` integer DEFAULT false NOT NULL,
	`is_closing` integer DEFAULT false NOT NULL,
	`reverses_entry_id` integer,
	`reversed_by_entry_id` integer,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_journal_entries_date_format" CHECK("__new_journal_entries"."entry_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_journal_entries_not_self_reversing" CHECK("__new_journal_entries"."reverses_entry_id" IS NULL OR "__new_journal_entries"."reverses_entry_id" <> "__new_journal_entries"."id"),
	CONSTRAINT "ck_journal_entries_source_type" CHECK("__new_journal_entries"."source_type" IN ('SALE', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN', 'CUSTOMER_PAYMENT', 'SUPPLIER_PAYMENT', 'EXPENSE', 'INCOME', 'STOCK_ADJUSTMENT', 'RECONCILIATION', 'OPENING_BALANCE', 'CAPITAL', 'DRAWINGS', 'TRANSFER', 'REVERSAL', 'YEAR_END_CLOSE')),
	CONSTRAINT "ck_journal_entries_traceable" CHECK("__new_journal_entries"."source_id" IS NOT NULL OR "__new_journal_entries"."source_type" IN ('OPENING_BALANCE', 'YEAR_END_CLOSE'))
);
--> statement-breakpoint
INSERT INTO `__new_journal_entries`("id", "entry_no", "entry_date", "occurred_at", "source_type", "source_id", "memo", "is_opening", "is_closing", "reverses_entry_id", "reversed_by_entry_id", "created_by", "is_demo", "created_at") SELECT "id", "entry_no", "entry_date", "occurred_at", "source_type", "source_id", "memo", "is_opening", "is_closing", "reverses_entry_id", "reversed_by_entry_id", "created_by", "is_demo", "created_at" FROM `journal_entries`;--> statement-breakpoint
DROP TABLE `journal_entries`;--> statement-breakpoint
ALTER TABLE `__new_journal_entries` RENAME TO `journal_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_entries_no` ON `journal_entries` (`entry_no`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_date` ON `journal_entries` (`entry_date`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_source` ON `journal_entries` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_occurred` ON `journal_entries` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_reverses` ON `journal_entries` (`reverses_entry_id`);