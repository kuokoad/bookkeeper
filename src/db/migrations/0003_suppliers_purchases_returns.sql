CREATE TABLE `suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`contact_person` text,
	`phone` text,
	`email` text,
	`address` text,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_suppliers_name" CHECK(length(trim("suppliers"."name")) > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_suppliers_name` ON `suppliers` (`name`);--> statement-breakpoint
CREATE INDEX `idx_suppliers_phone` ON `suppliers` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_suppliers_active` ON `suppliers` (`is_active`);--> statement-breakpoint
CREATE TABLE `purchase_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`unit` text NOT NULL,
	`qty_milli` integer NOT NULL,
	`unit_cost_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`line_total_minor` integer NOT NULL,
	`returned_qty_milli` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_purchase_items_qty_nonzero" CHECK("purchase_items"."qty_milli" <> 0),
	CONSTRAINT "ck_purchase_items_returned_nonneg" CHECK("purchase_items"."returned_qty_milli" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_purchase_items_purchase` ON `purchase_items` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_items_product` ON `purchase_items` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_items_purchase_line` ON `purchase_items` (`purchase_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `purchase_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`payment_account_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`reference` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_purchase_payments_amount_nonzero" CHECK("purchase_payments"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE INDEX `idx_purchase_payments_purchase` ON `purchase_payments` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_no` text NOT NULL,
	`kind` text DEFAULT 'PURCHASE' NOT NULL,
	`supplier_id` integer,
	`business_date` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`invoice_no` text,
	`subtotal_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer NOT NULL,
	`status` text DEFAULT 'POSTED' NOT NULL,
	`journal_entry_id` integer,
	`returns_purchase_id` integer,
	`voids_purchase_id` integer,
	`voided_by_purchase_id` integer,
	`voided_at` integer,
	`void_reason` text,
	`note` text,
	`created_by` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_purchases_status" CHECK("purchases"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_purchases_kind" CHECK("purchases"."kind" IN ('PURCHASE', 'RETURN', 'VOID')),
	CONSTRAINT "ck_purchases_date_format" CHECK("purchases"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_purchases_total_arithmetic" CHECK("purchases"."total_minor" = "purchases"."subtotal_minor" - "purchases"."discount_minor" + "purchases"."tax_minor"),
	CONSTRAINT "ck_purchases_not_self_voiding" CHECK("purchases"."voids_purchase_id" IS NULL OR "purchases"."voids_purchase_id" <> "purchases"."id"),
	CONSTRAINT "ck_purchases_not_self_returning" CHECK("purchases"."returns_purchase_id" IS NULL OR "purchases"."returns_purchase_id" <> "purchases"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchases_no` ON `purchases` (`purchase_no`);--> statement-breakpoint
CREATE INDEX `idx_purchases_date` ON `purchases` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_purchases_supplier` ON `purchases` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `idx_purchases_status` ON `purchases` (`status`);--> statement-breakpoint
CREATE INDEX `idx_purchases_kind` ON `purchases` (`kind`);--> statement-breakpoint
CREATE TABLE `supplier_payment_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_id` integer NOT NULL,
	`purchase_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `supplier_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_supplier_payment_allocations_amount_nonzero" CHECK("supplier_payment_allocations"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE INDEX `idx_supplier_payment_allocations_payment` ON `supplier_payment_allocations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `idx_supplier_payment_allocations_purchase` ON `supplier_payment_allocations` (`purchase_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_supplier_payment_allocations` ON `supplier_payment_allocations` (`payment_id`,`purchase_id`);--> statement-breakpoint
CREATE TABLE `supplier_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_no` text NOT NULL,
	`supplier_id` integer NOT NULL,
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
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_account_id`) REFERENCES `payment_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_supplier_payments_status" CHECK("supplier_payments"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_supplier_payments_amount_positive" CHECK("supplier_payments"."amount_minor" > 0),
	CONSTRAINT "ck_supplier_payments_date_format" CHECK("supplier_payments"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_supplier_payments_no` ON `supplier_payments` (`payment_no`);--> statement-breakpoint
CREATE INDEX `idx_supplier_payments_supplier` ON `supplier_payments` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `idx_supplier_payments_date` ON `supplier_payments` (`business_date`);--> statement-breakpoint
ALTER TABLE `journal_lines` ADD `supplier_id` integer REFERENCES suppliers(id);--> statement-breakpoint
CREATE INDEX `idx_journal_lines_supplier` ON `journal_lines` (`supplier_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sale_items` (
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
	`returned_qty_milli` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_sale_items_qty_nonzero" CHECK("__new_sale_items"."qty_milli" <> 0),
	CONSTRAINT "ck_sale_items_price_nonneg" CHECK("__new_sale_items"."unit_price_minor" >= 0),
	CONSTRAINT "ck_sale_items_discount_nonneg" CHECK("__new_sale_items"."discount_minor" >= 0),
	CONSTRAINT "ck_sale_items_returned_nonneg" CHECK("__new_sale_items"."returned_qty_milli" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_sale_items`("id", "sale_id", "line_no", "product_id", "product_name", "unit", "qty_milli", "unit_price_minor", "discount_minor", "line_total_minor", "unit_cost_minor", "total_cost_minor", "returned_qty_milli", "created_at") SELECT "id", "sale_id", "line_no", "product_id", "product_name", "unit", "qty_milli", "unit_price_minor", "discount_minor", "line_total_minor", "unit_cost_minor", "total_cost_minor", 0, "created_at" FROM `sale_items`;--> statement-breakpoint
DROP TABLE `sale_items`;--> statement-breakpoint
ALTER TABLE `__new_sale_items` RENAME TO `sale_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_sale_items_sale` ON `sale_items` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_sale_items_product` ON `sale_items` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sale_items_sale_line` ON `sale_items` (`sale_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `__new_sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`receipt_no` text NOT NULL,
	`kind` text DEFAULT 'SALE' NOT NULL,
	`returns_sale_id` integer,
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
	CONSTRAINT "ck_sales_status" CHECK("__new_sales"."status" IN ('POSTED', 'VOIDED')),
	CONSTRAINT "ck_sales_date_format" CHECK("__new_sales"."business_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_sales_discount_nonneg" CHECK("__new_sales"."discount_minor" >= 0),
	CONSTRAINT "ck_sales_tax_nonneg" CHECK("__new_sales"."tax_minor" >= 0),
	CONSTRAINT "ck_sales_total_arithmetic" CHECK("__new_sales"."total_minor" = "__new_sales"."subtotal_minor" - "__new_sales"."discount_minor" + "__new_sales"."tax_minor"),
	CONSTRAINT "ck_sales_not_self_voiding" CHECK("__new_sales"."voids_sale_id" IS NULL OR "__new_sales"."voids_sale_id" <> "__new_sales"."id"),
	CONSTRAINT "ck_sales_kind" CHECK("__new_sales"."kind" IN ('SALE', 'RETURN', 'VOID')),
	CONSTRAINT "ck_sales_not_self_returning" CHECK("__new_sales"."returns_sale_id" IS NULL OR "__new_sales"."returns_sale_id" <> "__new_sales"."id")
);
--> statement-breakpoint
INSERT INTO `__new_sales`("id", "receipt_no", "kind", "returns_sale_id", "business_date", "occurred_at", "customer_id", "subtotal_minor", "discount_minor", "tax_minor", "total_minor", "cogs_minor", "status", "journal_entry_id", "voided_by_sale_id", "voids_sale_id", "voided_at", "void_reason", "note", "created_by", "is_demo", "created_at", "updated_at") SELECT "id", "receipt_no", 'SALE', NULL, "business_date", "occurred_at", "customer_id", "subtotal_minor", "discount_minor", "tax_minor", "total_minor", "cogs_minor", "status", "journal_entry_id", "voided_by_sale_id", "voids_sale_id", "voided_at", "void_reason", "note", "created_by", "is_demo", "created_at", "updated_at" FROM `sales`;--> statement-breakpoint
DROP TABLE `sales`;--> statement-breakpoint
ALTER TABLE `__new_sales` RENAME TO `sales`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sales_receipt_no` ON `sales` (`receipt_no`);--> statement-breakpoint
CREATE INDEX `idx_sales_date` ON `sales` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_sales_customer` ON `sales` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_status` ON `sales` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sales_occurred` ON `sales` (`occurred_at`);