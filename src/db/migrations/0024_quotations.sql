-- HAND-EDITED, deliberately. Do not regenerate over this.
--
-- Two things drizzle-kit cannot write, both at the bottom of this file.
--
-- 1. The QUOTE numbering sequence, which is DATA. `seedSequences` would create
--    it, but that only runs on a fresh install and skips rows that already
--    exist. Without the INSERT below, an existing shop upgrades to a Quotations
--    menu whose very first quote fails to get a number.
--
-- 2. The value of `feature_quotations` for shops that already exist. A column
--    default has to be one value, but the right answer differs by business
--    type: a materials yard quotes constantly, a mini-mart almost never.
--
-- The rebuild of `user_permissions` above IS safe to regenerate: widening the
-- module CHECK forces the table copy, but every column in that SELECT already
-- exists on the old table, unlike the traps in 0022 and 0023.
CREATE TABLE `quotation_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quotation_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`unit` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`line_total_minor` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_quotation_items_qty_positive" CHECK("quotation_items"."qty_milli" > 0),
	CONSTRAINT "ck_quotation_items_price_nonneg" CHECK("quotation_items"."unit_price_minor" >= 0),
	CONSTRAINT "ck_quotation_items_discount_nonneg" CHECK("quotation_items"."discount_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_quotation_items_quotation` ON `quotation_items` (`quotation_id`);--> statement-breakpoint
CREATE INDEX `idx_quotation_items_product` ON `quotation_items` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_quotation_items_line` ON `quotation_items` (`quotation_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `quotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quote_no` text NOT NULL,
	`business_date` text NOT NULL,
	`valid_until` text NOT NULL,
	`customer_name` text NOT NULL,
	`customer_id` integer,
	`customer_phone` text,
	`reference` text,
	`subtotal_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`quote_discount_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer NOT NULL,
	`tax_inclusive` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`converted_sale_id` integer,
	`converted_at` integer,
	`override_reason` text,
	`cancelled_at` integer,
	`cancel_reason` text,
	`notes` text,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`converted_sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_quotations_status" CHECK("quotations"."status" IN ('OPEN', 'CONVERTED', 'CANCELLED')),
	CONSTRAINT "ck_quotations_name" CHECK(length(trim("quotations"."customer_name")) > 0),
	CONSTRAINT "ck_quotations_quote_no" CHECK(length(trim("quotations"."quote_no")) > 0),
	CONSTRAINT "ck_quotations_date_format" CHECK("quotations"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_quotations_valid_format" CHECK("quotations"."valid_until" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_quotations_dates" CHECK("quotations"."valid_until" >= "quotations"."business_date"),
	CONSTRAINT "ck_quotations_signs" CHECK("quotations"."subtotal_minor" >= 0 AND "quotations"."discount_minor" >= 0
        AND "quotations"."tax_minor" >= 0 AND "quotations"."total_minor" >= 0),
	CONSTRAINT "ck_quotations_total_arithmetic" CHECK("quotations"."total_minor" = "quotations"."subtotal_minor" - "quotations"."discount_minor" + "quotations"."tax_minor"),
	CONSTRAINT "ck_quotations_converted_link" CHECK(("quotations"."status" = 'CONVERTED') = ("quotations"."converted_sale_id" IS NOT NULL)),
	CONSTRAINT "ck_quotations_cancelled_reason" CHECK("quotations"."status" = 'CANCELLED' OR "quotations"."cancelled_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_quotations_no` ON `quotations` (`quote_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_quotations_converted_sale` ON `quotations` (`converted_sale_id`);--> statement-breakpoint
CREATE INDEX `idx_quotations_status` ON `quotations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_quotations_date` ON `quotations` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_quotations_valid_until` ON `quotations` (`valid_until`);--> statement-breakpoint
CREATE INDEX `idx_quotations_customer` ON `quotations` (`customer_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_permissions` (
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
	CONSTRAINT "ck_user_permissions_module" CHECK("__new_user_permissions"."module" IN ('sales', 'purchases', 'inventory', 'products', 'customers', 'suppliers', 'expenses', 'income', 'accounts', 'reports', 'reconciliation', 'quotations', 'users', 'settings'))
);
--> statement-breakpoint
INSERT INTO `__new_user_permissions`("id", "user_id", "module", "can_view", "can_create", "can_edit", "can_void", "created_at", "updated_at") SELECT "id", "user_id", "module", "can_view", "can_create", "can_edit", "can_void", "created_at", "updated_at" FROM `user_permissions`;--> statement-breakpoint
DROP TABLE `user_permissions`;--> statement-breakpoint
ALTER TABLE `__new_user_permissions` RENAME TO `user_permissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_permissions_user_module` ON `user_permissions` (`user_id`,`module`);--> statement-breakpoint
ALTER TABLE `business_settings` ADD `feature_quotations` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- The numbering for quotes. OR IGNORE so re-running this against a database
-- that already has it is a no-op rather than a constraint error.
INSERT OR IGNORE INTO `sequences` ("doc_type", "prefix", "next_number", "padding")
VALUES ('QUOTE', 'QTE-', 1, 5);--> statement-breakpoint
-- Set the new switch from each shop's OWN declared type, which is what it would
-- have been given had the feature existed when the shop chose that type.
-- Without this a provisions shop finds a Quotations menu it never asked for.
UPDATE `business_settings`
SET `feature_quotations` = CASE `business_type` WHEN 'general_retail' THEN 0 ELSE 1 END;
