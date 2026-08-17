CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`email` text,
	`address` text,
	`notes` text,
	`credit_limit_minor` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_customers_name" CHECK(length(trim("customers"."name")) > 0),
	CONSTRAINT "ck_customers_credit_limit" CHECK("customers"."credit_limit_minor" IS NULL OR "customers"."credit_limit_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_customers_name` ON `customers` (`name`);--> statement-breakpoint
CREATE INDEX `idx_customers_phone` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_customers_active` ON `customers` (`is_active`);--> statement-breakpoint
CREATE TABLE `customer_payment_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_id` integer NOT NULL,
	`sale_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `customer_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_customer_payment_allocations_amount_nonzero" CHECK("customer_payment_allocations"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE INDEX `idx_customer_payment_allocations_payment` ON `customer_payment_allocations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `idx_customer_payment_allocations_sale` ON `customer_payment_allocations` (`sale_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_payment_allocations` ON `customer_payment_allocations` (`payment_id`,`sale_id`);--> statement-breakpoint
CREATE TABLE `customer_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_no` text NOT NULL,
	`customer_id` integer NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`payment_account_id` integer NOT NULL,
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
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_customer_payments_status" CHECK("customer_payments"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_customer_payments_amount_positive" CHECK("customer_payments"."amount_minor" > 0),
	CONSTRAINT "ck_customer_payments_date_format" CHECK("customer_payments"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_customer_payments_no` ON `customer_payments` (`payment_no`);--> statement-breakpoint
CREATE INDEX `idx_customer_payments_customer` ON `customer_payments` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_customer_payments_date` ON `customer_payments` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_customer_payments_status` ON `customer_payments` (`status`);--> statement-breakpoint
CREATE TABLE `sale_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`unit` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`line_total_minor` integer NOT NULL,
	`unit_cost_minor` integer DEFAULT 0 NOT NULL,
	`total_cost_minor` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_sale_items_qty_nonzero" CHECK("sale_items"."qty_milli" <> 0),
	CONSTRAINT "ck_sale_items_price_nonneg" CHECK("sale_items"."unit_price_minor" >= 0),
	CONSTRAINT "ck_sale_items_discount_nonneg" CHECK("sale_items"."discount_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_sale_items_sale` ON `sale_items` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_sale_items_product` ON `sale_items` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sale_items_sale_line` ON `sale_items` (`sale_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `sale_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`payment_account_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`reference` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_sale_payments_amount_nonzero" CHECK("sale_payments"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE INDEX `idx_sale_payments_sale` ON `sale_payments` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_sale_payments_account` ON `sale_payments` (`payment_account_id`);--> statement-breakpoint
CREATE TABLE `sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`receipt_no` text NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`customer_id` integer,
	`subtotal_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer NOT NULL,
	`cogs_minor` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'POSTED' NOT NULL,
	`journal_entry_id` integer,
	`voided_by_sale_id` integer,
	`voids_sale_id` integer,
	`voided_at` integer,
	`void_reason` text,
	`note` text,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_sales_status" CHECK("sales"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_sales_date_format" CHECK("sales"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_sales_discount_nonneg" CHECK("sales"."discount_minor" >= 0),
	CONSTRAINT "ck_sales_tax_nonneg" CHECK("sales"."tax_minor" >= 0),
	CONSTRAINT "ck_sales_total_arithmetic" CHECK("sales"."total_minor" = "sales"."subtotal_minor" - "sales"."discount_minor" + "sales"."tax_minor"),
	CONSTRAINT "ck_sales_not_self_voiding" CHECK("sales"."voids_sale_id" IS NULL OR "sales"."voids_sale_id" <> "sales"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sales_receipt_no` ON `sales` (`receipt_no`);--> statement-breakpoint
CREATE INDEX `idx_sales_date` ON `sales` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_sales_customer` ON `sales` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_status` ON `sales` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sales_occurred` ON `sales` (`occurred_at`);--> statement-breakpoint
ALTER TABLE `journal_lines` ADD `customer_id` integer REFERENCES customers(id);--> statement-breakpoint
CREATE INDEX `idx_journal_lines_customer` ON `journal_lines` (`customer_id`);