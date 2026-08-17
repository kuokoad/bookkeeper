CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`username` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`summary` text NOT NULL,
	`metadata` text,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "ck_audit_logs_action" CHECK("audit_logs"."action" IN ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT', 'CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE', 'VOID', 'REVERSE', 'RECONCILE', 'PERMISSION_CHANGE', 'PASSWORD_CHANGE', 'SETTINGS_CHANGE', 'SEED_DEMO', 'PURGE_DEMO')),
	CONSTRAINT "ck_audit_logs_summary" CHECK(length("audit_logs"."summary") > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_created_at` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_entity` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_user` ON `audit_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_action` ON `audit_logs` (`action`);--> statement-breakpoint
CREATE TABLE `business_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`business_name` text DEFAULT 'My Shop' NOT NULL,
	`address` text,
	`phone` text,
	`email` text,
	`logo_path` text,
	`currency_code` text DEFAULT 'GHS' NOT NULL,
	`currency_symbol` text DEFAULT '₵' NOT NULL,
	`tax_enabled` integer DEFAULT false NOT NULL,
	`tax_rate_bp` integer DEFAULT 0 NOT NULL,
	`tax_inclusive` integer DEFAULT false NOT NULL,
	`tax_label` text DEFAULT 'VAT' NOT NULL,
	`low_stock_threshold_milli` integer DEFAULT 5000 NOT NULL,
	`allow_negative_stock` integer DEFAULT false NOT NULL,
	`allow_overpayment` integer DEFAULT false NOT NULL,
	`financial_year_start_month` integer DEFAULT 1 NOT NULL,
	`has_demo_data` integer DEFAULT false NOT NULL,
	`setup_completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "ck_business_settings_singleton" CHECK("business_settings"."id" = 1),
	CONSTRAINT "ck_business_settings_tax_rate" CHECK("business_settings"."tax_rate_bp" >= 0 AND "business_settings"."tax_rate_bp" <= 100000),
	CONSTRAINT "ck_business_settings_fy_month" CHECK("business_settings"."financial_year_start_month" BETWEEN 1 AND 12),
	CONSTRAINT "ck_business_settings_currency" CHECK(length("business_settings"."currency_code") BETWEEN 2 AND 4)
);
--> statement-breakpoint
CREATE TABLE `sequences` (
	`doc_type` text PRIMARY KEY NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`next_number` integer DEFAULT 1 NOT NULL,
	`padding` integer DEFAULT 5 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "ck_sequences_next_positive" CHECK("sequences"."next_number" >= 1),
	CONSTRAINT "ck_sequences_padding" CHECK("sequences"."padding" BETWEEN 0 AND 12)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`module` text NOT NULL,
	`can_view` integer DEFAULT false NOT NULL,
	`can_create` integer DEFAULT false NOT NULL,
	`can_edit` integer DEFAULT false NOT NULL,
	`can_void` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_user_permissions_module" CHECK("user_permissions"."module" IN ('sales', 'purchases', 'inventory', 'products', 'customers', 'suppliers', 'expenses', 'income', 'accounts', 'reports', 'reconciliation', 'users', 'settings'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_permissions_user_module` ON `user_permissions` (`user_id`,`module`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'STAFF' NOT NULL,
	`password_hash` text NOT NULL,
	`pin_hash` text,
	`is_active` integer DEFAULT true NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_login_at` integer,
	`must_change_password` integer DEFAULT false NOT NULL,
	`created_by` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "ck_users_username_len" CHECK(length("users"."username") BETWEEN 3 AND 40),
	CONSTRAINT "ck_users_failed_login_count" CHECK("users"."failed_login_count" >= 0),
	CONSTRAINT "ck_users_role" CHECK("users"."role" IN ('OWNER', 'STAFF'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_username` ON `users` (lower("username"));--> statement-breakpoint
CREATE INDEX `idx_users_active` ON `users` (`is_active`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`normal_balance` text NOT NULL,
	`parent_id` integer,
	`is_system` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "ck_accounts_code_len" CHECK(length("accounts"."code") BETWEEN 1 AND 20),
	CONSTRAINT "ck_accounts_parent_not_self" CHECK("accounts"."parent_id" IS NULL OR "accounts"."parent_id" <> "accounts"."id"),
	CONSTRAINT "ck_accounts_type" CHECK("accounts"."type" IN ('ASSET', 'LIABILITY', 'EQUITY', 'CONTRA_EQUITY', 'REVENUE', 'CONTRA_REVENUE', 'COGS', 'EXPENSE')),
	CONSTRAINT "ck_accounts_normal_balance" CHECK("accounts"."normal_balance" IN ('DEBIT', 'CREDIT')),
	CONSTRAINT "ck_accounts_normal_balance_matches_type" CHECK(("accounts"."type" IN ('ASSET','EXPENSE','COGS','CONTRA_EQUITY','CONTRA_REVENUE') AND "accounts"."normal_balance" = 'DEBIT')
          OR ("accounts"."type" IN ('LIABILITY','EQUITY','REVENUE') AND "accounts"."normal_balance" = 'CREDIT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_accounts_code` ON `accounts` (`code`);--> statement-breakpoint
CREATE INDEX `idx_accounts_type` ON `accounts` (`type`);--> statement-breakpoint
CREATE INDEX `idx_accounts_parent` ON `accounts` (`parent_id`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_no` text NOT NULL,
	`entry_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer,
	`memo` text,
	`is_opening` integer DEFAULT false NOT NULL,
	`reverses_entry_id` integer,
	`reversed_by_entry_id` integer,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_journal_entries_date_format" CHECK("journal_entries"."entry_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_journal_entries_not_self_reversing" CHECK("journal_entries"."reverses_entry_id" IS NULL OR "journal_entries"."reverses_entry_id" <> "journal_entries"."id"),
	CONSTRAINT "ck_journal_entries_source_type" CHECK("journal_entries"."source_type" IN ('SALE', 'SALE_RETURN', 'PURCHASE', 'PURCHASE_RETURN', 'CUSTOMER_PAYMENT', 'SUPPLIER_PAYMENT', 'EXPENSE', 'INCOME', 'STOCK_ADJUSTMENT', 'RECONCILIATION', 'OPENING_BALANCE', 'CAPITAL', 'DRAWINGS', 'REVERSAL')),
	CONSTRAINT "ck_journal_entries_traceable" CHECK("journal_entries"."source_id" IS NOT NULL OR "journal_entries"."source_type" = 'OPENING_BALANCE')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_entries_no` ON `journal_entries` (`entry_no`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_date` ON `journal_entries` (`entry_date`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_source` ON `journal_entries` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_occurred` ON `journal_entries` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_journal_entries_reverses` ON `journal_entries` (`reverses_entry_id`);--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`account_id` integer NOT NULL,
	`debit_minor` integer DEFAULT 0 NOT NULL,
	`credit_minor` integer DEFAULT 0 NOT NULL,
	`payment_account_id` integer,
	`description` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_journal_lines_debit_nonneg" CHECK("journal_lines"."debit_minor" >= 0),
	CONSTRAINT "ck_journal_lines_credit_nonneg" CHECK("journal_lines"."credit_minor" >= 0),
	CONSTRAINT "ck_journal_lines_one_sided" CHECK(("journal_lines"."debit_minor" = 0 AND "journal_lines"."credit_minor" > 0) OR ("journal_lines"."debit_minor" > 0 AND "journal_lines"."credit_minor" = 0))
);
--> statement-breakpoint
CREATE INDEX `idx_journal_lines_entry` ON `journal_lines` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_lines_account` ON `journal_lines` (`account_id`,`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_lines_payment_account` ON `journal_lines` (`payment_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_journal_lines_entry_line` ON `journal_lines` (`entry_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `payment_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text,
	`account_number` text,
	`gl_account_id` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`gl_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_payment_accounts_kind" CHECK("payment_accounts"."kind" IN ('CASH', 'MOBILE_MONEY', 'BANK', 'OTHER')),
	CONSTRAINT "ck_payment_accounts_name" CHECK(length("payment_accounts"."name") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_payment_accounts_name` ON `payment_accounts` (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX `uq_payment_accounts_gl` ON `payment_accounts` (`gl_account_id`);--> statement-breakpoint
CREATE INDEX `idx_payment_accounts_active` ON `payment_accounts` (`is_active`);