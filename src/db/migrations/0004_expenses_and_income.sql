CREATE TABLE `expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`expense_no` text NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`category_account_id` integer NOT NULL,
	`description` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`payment_account_id` integer NOT NULL,
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
	FOREIGN KEY (`category_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_expenses_status" CHECK("expenses"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_expenses_amount_positive" CHECK("expenses"."amount_minor" > 0),
	CONSTRAINT "ck_expenses_description" CHECK(length(trim("expenses"."description")) > 0),
	CONSTRAINT "ck_expenses_date_format" CHECK("expenses"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_expenses_no` ON `expenses` (`expense_no`);--> statement-breakpoint
CREATE INDEX `idx_expenses_date` ON `expenses` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_expenses_category` ON `expenses` (`category_account_id`);--> statement-breakpoint
CREATE INDEX `idx_expenses_payment_account` ON `expenses` (`payment_account_id`);--> statement-breakpoint
CREATE INDEX `idx_expenses_status` ON `expenses` (`status`);--> statement-breakpoint
CREATE TABLE `incomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`income_no` text NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`category_account_id` integer NOT NULL,
	`description` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`payment_account_id` integer NOT NULL,
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
	FOREIGN KEY (`category_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_incomes_status" CHECK("incomes"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_incomes_amount_positive" CHECK("incomes"."amount_minor" > 0),
	CONSTRAINT "ck_incomes_description" CHECK(length(trim("incomes"."description")) > 0),
	CONSTRAINT "ck_incomes_date_format" CHECK("incomes"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_incomes_no` ON `incomes` (`income_no`);--> statement-breakpoint
CREATE INDEX `idx_incomes_date` ON `incomes` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_incomes_category` ON `incomes` (`category_account_id`);--> statement-breakpoint
CREATE INDEX `idx_incomes_payment_account` ON `incomes` (`payment_account_id`);--> statement-breakpoint
CREATE INDEX `idx_incomes_status` ON `incomes` (`status`);