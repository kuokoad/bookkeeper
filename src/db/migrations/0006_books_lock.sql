PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_business_settings` (
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
	`books_locked_before` text,
	`has_demo_data` integer DEFAULT false NOT NULL,
	`setup_completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "ck_business_settings_singleton" CHECK("__new_business_settings"."id" = 1),
	CONSTRAINT "ck_business_settings_tax_rate" CHECK("__new_business_settings"."tax_rate_bp" >= 0 AND "__new_business_settings"."tax_rate_bp" <= 100000),
	CONSTRAINT "ck_business_settings_fy_month" CHECK("__new_business_settings"."financial_year_start_month" BETWEEN 1 AND 12),
	CONSTRAINT "ck_business_settings_currency" CHECK(length("__new_business_settings"."currency_code") BETWEEN 2 AND 4),
	CONSTRAINT "ck_business_settings_lock_date_format" CHECK("__new_business_settings"."books_locked_before" IS NULL OR "__new_business_settings"."books_locked_before" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
INSERT INTO `__new_business_settings`("id", "business_name", "address", "phone", "email", "logo_path", "currency_code", "currency_symbol", "tax_enabled", "tax_rate_bp", "tax_inclusive", "tax_label", "low_stock_threshold_milli", "allow_negative_stock", "allow_overpayment", "financial_year_start_month", "books_locked_before", "has_demo_data", "setup_completed_at", "created_at", "updated_at") SELECT "id", "business_name", "address", "phone", "email", "logo_path", "currency_code", "currency_symbol", "tax_enabled", "tax_rate_bp", "tax_inclusive", "tax_label", "low_stock_threshold_milli", "allow_negative_stock", "allow_overpayment", "financial_year_start_month", NULL, "has_demo_data", "setup_completed_at", "created_at", "updated_at" FROM `business_settings`;--> statement-breakpoint
DROP TABLE `business_settings`;--> statement-breakpoint
ALTER TABLE `__new_business_settings` RENAME TO `business_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;