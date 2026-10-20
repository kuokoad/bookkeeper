CREATE TABLE `units` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`decimal_places` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "ck_units_symbol" CHECK(length(trim("units"."symbol")) > 0),
	CONSTRAINT "ck_units_decimals" CHECK("units"."decimal_places" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_units_symbol_nocase` ON `units` (lower("symbol"));--> statement-breakpoint
-- Every unit the shop has already typed becomes a Units entry. Spellings that
-- differ only in case ('pcs', 'Pcs') are one unit, and the products are moved
-- onto a single spelling so the foreign key below can hold.
INSERT INTO `units` ("symbol", "name", "decimal_places")
SELECT min(trim("unit")), min(trim("unit")), 0 FROM `products` GROUP BY lower(trim("unit"));--> statement-breakpoint
-- A fresh shop needs at least one unit to create its first product.
INSERT OR IGNORE INTO `units` ("symbol", "name", "decimal_places") VALUES ('pcs', 'Pieces', 0);--> statement-breakpoint
UPDATE `products` SET "unit" = (SELECT u."symbol" FROM `units` u WHERE lower(u."symbol") = lower(trim(`products`."unit")));--> statement-breakpoint
-- Decimals are enforced from now on, so a unit already holding a fraction
-- anywhere (stock, the ledger, a document line, a reorder level) keeps three
-- places. Document lines are checked as well as the ledger because a service
-- (labour by the hour, cartage) is sold without ever touching stock.
-- Everything else starts whole; the owner can widen it on the Units screen.
UPDATE `units` SET "decimal_places" = 3 WHERE "symbol" IN (
  SELECT p."unit" FROM `products` p WHERE p."qty_on_hand_milli" % 1000 <> 0 OR coalesce(p."min_stock_milli", 0) % 1000 <> 0
  UNION SELECT p."unit" FROM `products` p JOIN `stock_ledger` l ON l."product_id" = p."id"
    WHERE l."qty_in_milli" % 1000 <> 0 OR l."qty_out_milli" % 1000 <> 0
  UNION SELECT p."unit" FROM `products` p JOIN `quotation_items` q ON q."product_id" = p."id"
    WHERE q."qty_milli" % 1000 <> 0
  UNION SELECT p."unit" FROM `products` p JOIN `sale_items` s ON s."product_id" = p."id"
    WHERE s."qty_milli" % 1000 <> 0
  UNION SELECT p."unit" FROM `products` p JOIN `purchase_items` pi ON pi."product_id" = p."id"
    WHERE pi."qty_milli" % 1000 <> 0
);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sku` text,
	`barcode` text,
	`category_id` integer,
	`unit` text NOT NULL,
	`alt_unit` text,
	`alt_factor_milli` integer,
	`alt_cost_price_minor` integer,
	`alt_selling_price_minor` integer,
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
	FOREIGN KEY (`unit`) REFERENCES `units`(`symbol`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`alt_unit`) REFERENCES `units`(`symbol`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_products_name" CHECK(length(trim("__new_products"."name")) > 0),
	CONSTRAINT "ck_products_unit" CHECK(length(trim("__new_products"."unit")) > 0),
	CONSTRAINT "ck_products_alt_unit" CHECK(("__new_products"."alt_unit" IS NULL AND "__new_products"."alt_factor_milli" IS NULL AND "__new_products"."alt_cost_price_minor" IS NULL AND "__new_products"."alt_selling_price_minor" IS NULL)
        OR ("__new_products"."alt_unit" IS NOT NULL AND "__new_products"."alt_factor_milli" > 0 AND "__new_products"."alt_unit" <> "__new_products"."unit")),
	CONSTRAINT "ck_products_alt_prices" CHECK(coalesce("__new_products"."alt_cost_price_minor", 0) >= 0 AND coalesce("__new_products"."alt_selling_price_minor", 0) >= 0),
	CONSTRAINT "ck_products_cost_price" CHECK("__new_products"."cost_price_minor" >= 0),
	CONSTRAINT "ck_products_selling_price" CHECK("__new_products"."selling_price_minor" >= 0),
	CONSTRAINT "ck_products_min_stock" CHECK("__new_products"."min_stock_milli" IS NULL OR "__new_products"."min_stock_milli" >= 0),
	CONSTRAINT "ck_products_warn_days" CHECK("__new_products"."warn_days" IS NULL OR "__new_products"."warn_days" >= 0),
	CONSTRAINT "ck_products_zero_qty_zero_value" CHECK("__new_products"."qty_on_hand_milli" <> 0 OR "__new_products"."stock_value_minor" = 0)
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "name", "sku", "barcode", "category_id", "unit", "alt_unit", "alt_factor_milli", "alt_cost_price_minor", "alt_selling_price_minor", "description", "cost_price_minor", "selling_price_minor", "min_stock_milli", "warn_days", "qty_on_hand_milli", "stock_value_minor", "track_inventory", "is_active", "created_by", "is_demo", "created_at", "updated_at") SELECT "id", "name", "sku", "barcode", "category_id", "unit", NULL, NULL, NULL, NULL, "description", "cost_price_minor", "selling_price_minor", "min_stock_milli", "warn_days", "qty_on_hand_milli", "stock_value_minor", "track_inventory", "is_active", "created_by", "is_demo", "created_at", "updated_at" FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_sku` ON `products` (lower("sku"));--> statement-breakpoint
CREATE UNIQUE INDEX `uq_products_barcode` ON `products` (`barcode`);--> statement-breakpoint
CREATE INDEX `idx_products_category` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_products_active` ON `products` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_products_name` ON `products` (`name`);--> statement-breakpoint
ALTER TABLE `stock_adjustment_items` ADD `entry_unit` text;--> statement-breakpoint
ALTER TABLE `stock_adjustment_items` ADD `entry_qty_milli` integer;--> statement-breakpoint
ALTER TABLE `stock_adjustment_items` ADD `entry_factor_milli` integer;--> statement-breakpoint
ALTER TABLE `sale_items` ADD `entry_unit` text;--> statement-breakpoint
ALTER TABLE `sale_items` ADD `entry_qty_milli` integer;--> statement-breakpoint
ALTER TABLE `sale_items` ADD `entry_factor_milli` integer;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `entry_unit` text;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `entry_qty_milli` integer;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `entry_factor_milli` integer;--> statement-breakpoint
ALTER TABLE `quotation_items` ADD `entry_unit` text;--> statement-breakpoint
ALTER TABLE `quotation_items` ADD `entry_qty_milli` integer;--> statement-breakpoint
ALTER TABLE `quotation_items` ADD `entry_factor_milli` integer;