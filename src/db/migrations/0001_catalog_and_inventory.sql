CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "ck_categories_name" CHECK(length(trim("categories"."name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_categories_name` ON `categories` (lower("name"));--> statement-breakpoint
CREATE INDEX `idx_categories_active` ON `categories` (`is_active`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sku` text,
	`barcode` text,
	`category_id` integer,
	`unit` text DEFAULT 'pcs' NOT NULL,
	`description` text,
	`cost_price_minor` integer DEFAULT 0 NOT NULL,
	`selling_price_minor` integer DEFAULT 0 NOT NULL,
	`min_stock_milli` integer,
	`qty_on_hand_milli` integer DEFAULT 0 NOT NULL,
	`stock_value_minor` integer DEFAULT 0 NOT NULL,
	`track_inventory` integer DEFAULT true NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_products_name" CHECK(length(trim("products"."name")) > 0),
	CONSTRAINT "ck_products_unit" CHECK(length(trim("products"."unit")) > 0),
	CONSTRAINT "ck_products_cost_price" CHECK("products"."cost_price_minor" >= 0),
	CONSTRAINT "ck_products_selling_price" CHECK("products"."selling_price_minor" >= 0),
	CONSTRAINT "ck_products_min_stock" CHECK("products"."min_stock_milli" IS NULL OR "products"."min_stock_milli" >= 0),
	CONSTRAINT "ck_products_zero_qty_zero_value" CHECK("products"."qty_on_hand_milli" <> 0 OR "products"."stock_value_minor" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_sku` ON `products` (lower("sku"));--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_barcode` ON `products` (`barcode`);--> statement-breakpoint
CREATE INDEX `idx_products_category` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_products_active` ON `products` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_products_name` ON `products` (`name`);--> statement-breakpoint
CREATE TABLE `stock_adjustment_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`adjustment_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`direction` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_cost_minor` integer DEFAULT 0 NOT NULL,
	`total_cost_minor` integer DEFAULT 0 NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`adjustment_id`) REFERENCES `stock_adjustments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_stock_adjustment_items_direction" CHECK("stock_adjustment_items"."direction" IN ('IN', 'OUT')),
	CONSTRAINT "ck_stock_adjustment_items_qty_positive" CHECK("stock_adjustment_items"."qty_milli" > 0),
	CONSTRAINT "ck_stock_adjustment_items_cost_nonneg" CHECK("stock_adjustment_items"."total_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_stock_adjustment_items_adjustment` ON `stock_adjustment_items` (`adjustment_id`);--> statement-breakpoint
CREATE INDEX `idx_stock_adjustment_items_product` ON `stock_adjustment_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `stock_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`adjustment_no` text NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'POSTED' NOT NULL,
	`journal_entry_id` integer,
	`voided_by_adjustment_id` integer,
	`voids_adjustment_id` integer,
	`voided_at` integer,
	`void_reason` text,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_stock_adjustments_reason" CHECK("stock_adjustments"."reason" IN ('OPENING_STOCK', 'DAMAGED', 'LOST', 'EXPIRED', 'FOUND', 'COUNT_CORRECTION', 'INTERNAL_USE', 'OTHER')),
	CONSTRAINT "ck_stock_adjustments_status" CHECK("stock_adjustments"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_stock_adjustments_date_format" CHECK("stock_adjustments"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_stock_adjustments_not_self_voiding" CHECK("stock_adjustments"."voids_adjustment_id" IS NULL OR "stock_adjustments"."voids_adjustment_id" <> "stock_adjustments"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_stock_adjustments_no` ON `stock_adjustments` (`adjustment_no`);--> statement-breakpoint
CREATE INDEX `idx_stock_adjustments_date` ON `stock_adjustments` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_stock_adjustments_status` ON `stock_adjustments` (`status`);--> statement-breakpoint
CREATE INDEX `idx_stock_adjustments_reason` ON `stock_adjustments` (`reason`);--> statement-breakpoint
CREATE TABLE `stock_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`movement_type` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer,
	`source_ref` text,
	`qty_in_milli` integer DEFAULT 0 NOT NULL,
	`qty_out_milli` integer DEFAULT 0 NOT NULL,
	`unit_cost_minor` integer DEFAULT 0 NOT NULL,
	`total_cost_minor` integer DEFAULT 0 NOT NULL,
	`balance_qty_milli` integer NOT NULL,
	`balance_value_minor` integer NOT NULL,
	`note` text,
	`user_id` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_stock_ledger_movement_type" CHECK("stock_ledger"."movement_type" IN ('OPENING_STOCK', 'PURCHASE', 'PURCHASE_RETURN', 'SALE', 'SALE_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT')),
	CONSTRAINT "ck_stock_ledger_qty_in_nonneg" CHECK("stock_ledger"."qty_in_milli" >= 0),
	CONSTRAINT "ck_stock_ledger_qty_out_nonneg" CHECK("stock_ledger"."qty_out_milli" >= 0),
	CONSTRAINT "ck_stock_ledger_one_direction" CHECK(("stock_ledger"."qty_in_milli" > 0 AND "stock_ledger"."qty_out_milli" = 0) OR ("stock_ledger"."qty_in_milli" = 0 AND "stock_ledger"."qty_out_milli" > 0)),
	CONSTRAINT "ck_stock_ledger_date_format" CHECK("stock_ledger"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_stock_ledger_zero_qty_zero_value" CHECK("stock_ledger"."balance_qty_milli" <> 0 OR "stock_ledger"."balance_value_minor" = 0)
);
--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_product` ON `stock_ledger` (`product_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_date` ON `stock_ledger` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_occurred` ON `stock_ledger` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_source` ON `stock_ledger` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_movement` ON `stock_ledger` (`movement_type`);