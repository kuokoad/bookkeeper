-- Hand-corrected. drizzle-kit generated `SELECT ... "warn_days" ... FROM products`
-- for a column that does not exist on the OLD table, which fails on every
-- database this has to run against. NULL is the right value anyway: no product
-- has a warning period of its own until somebody sets one, and null means
-- "use the shop's setting".
--
-- It also re-created the case-insensitive SKU index as `lower("sku")` in
-- BACKTICKS, which SQLite reads as a column name rather than an expression.
-- Restored to the form 0001 used.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_products` (
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
	`warn_days` integer,
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
	CONSTRAINT "ck_products_name" CHECK(length(trim("__new_products"."name")) > 0),
	CONSTRAINT "ck_products_unit" CHECK(length(trim("__new_products"."unit")) > 0),
	CONSTRAINT "ck_products_cost_price" CHECK("__new_products"."cost_price_minor" >= 0),
	CONSTRAINT "ck_products_selling_price" CHECK("__new_products"."selling_price_minor" >= 0),
	CONSTRAINT "ck_products_min_stock" CHECK("__new_products"."min_stock_milli" IS NULL OR "__new_products"."min_stock_milli" >= 0),
	CONSTRAINT "ck_products_warn_days" CHECK("__new_products"."warn_days" IS NULL OR "__new_products"."warn_days" >= 0),
	CONSTRAINT "ck_products_zero_qty_zero_value" CHECK("__new_products"."qty_on_hand_milli" <> 0 OR "__new_products"."stock_value_minor" = 0)
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "name", "sku", "barcode", "category_id", "unit", "description", "cost_price_minor", "selling_price_minor", "min_stock_milli", "warn_days", "qty_on_hand_milli", "stock_value_minor", "track_inventory", "is_active", "created_by", "is_demo", "created_at", "updated_at") SELECT "id", "name", "sku", "barcode", "category_id", "unit", "description", "cost_price_minor", "selling_price_minor", "min_stock_milli", NULL, "qty_on_hand_milli", "stock_value_minor", "track_inventory", "is_active", "created_by", "is_demo", "created_at", "updated_at" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_sku` ON `products` (lower("sku"));--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_barcode` ON `products` (`barcode`);--> statement-breakpoint
CREATE INDEX `idx_products_category` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_products_active` ON `products` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_products_name` ON `products` (`name`);