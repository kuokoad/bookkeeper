CREATE TABLE `year_end_closings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`start_year` integer NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`journal_entry_id` integer NOT NULL,
	`profit_minor` integer NOT NULL,
	`drawings_minor` integer NOT NULL,
	`closed_by` integer,
	`closed_at` integer NOT NULL,
	`reversed_at` integer,
	`reversed_by` integer,
	`reversal_entry_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reversed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reversal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_year_end_closings_period" CHECK("year_end_closings"."period_end" > "year_end_closings"."period_start"),
	CONSTRAINT "ck_year_end_closings_reversal" CHECK(("year_end_closings"."reversed_at" IS NULL AND "year_end_closings"."reversal_entry_id" IS NULL)
          OR ("year_end_closings"."reversed_at" IS NOT NULL AND "year_end_closings"."reversal_entry_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_year_end_closings_open` ON `year_end_closings` (`start_year`) WHERE "year_end_closings"."reversed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_year_end_closings_year` ON `year_end_closings` (`start_year`);--> statement-breakpoint
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
	CONSTRAINT "ck_journal_entries_source_type" CHECK("__new_journal_entries"."source_type" IN ('SALE', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN', 'CUSTOMER_PAYMENT', 'SUPPLIER_PAYMENT', 'EXPENSE', 'INCOME', 'STOCK_ADJUSTMENT', 'RECONCILIATION', 'OPENING_BALANCE', 'CAPITAL', 'DRAWINGS', 'REVERSAL', 'YEAR_END_CLOSE')),
	CONSTRAINT "ck_journal_entries_traceable" CHECK("__new_journal_entries"."source_id" IS NOT NULL OR "__new_journal_entries"."source_type" IN ('OPENING_BALANCE', 'YEAR_END_CLOSE'))
);
--> statement-breakpoint
INSERT INTO `__new_journal_entries`("id", "entry_no", "entry_date", "occurred_at", "source_type", "source_id", "memo", "is_opening", "is_closing", "reverses_entry_id", "reversed_by_entry_id", "created_by", "is_demo", "created_at") SELECT "id", "entry_no", "entry_date", "occurred_at", "source_type", "source_id", "memo", "is_opening", 0, "reverses_entry_id", "reversed_by_entry_id", "created_by", "is_demo", "created_at" FROM `journal_entries`;--> statement-breakpoint
DROP TABLE `journal_entries`;--> statement-breakpoint
ALTER TABLE `__new_journal_entries` RENAME TO `journal_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_entries_no` ON `journal_entries` (`entry_no`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_date` ON `journal_entries` (`entry_date`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_source` ON `journal_entries` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_occurred` ON `journal_entries` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_reverses` ON `journal_entries` (`reverses_entry_id`);