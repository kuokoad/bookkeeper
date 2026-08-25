CREATE TABLE `product_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`batch_ref` text NOT NULL,
	`expiry_date` text,
	`received_date` text NOT NULL,
	`qty_milli` integer DEFAULT 0 NOT NULL,
	`opening_qty_milli` integer DEFAULT 0 NOT NULL,
	`source_type` text NOT NULL,
	`source_id` integer,
	`supplier_id` integer,
	`warn_days` integer,
	`note` text,
	`is_closed` integer DEFAULT false NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_product_batches_ref" CHECK(length(trim("product_batches"."batch_ref")) > 0),
	CONSTRAINT "ck_product_batches_expiry_format" CHECK("product_batches"."expiry_date" IS NULL OR "product_batches"."expiry_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_product_batches_received_format" CHECK("product_batches"."received_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_product_batches_warn_days" CHECK("product_batches"."warn_days" IS NULL OR "product_batches"."warn_days" >= 0),
	CONSTRAINT "ck_product_batches_closed_is_empty" CHECK("product_batches"."is_closed" = 0 OR "product_batches"."qty_milli" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_batches_ref` ON `product_batches` (`batch_ref`);--> statement-breakpoint
CREATE INDEX `idx_product_batches_product` ON `product_batches` (`product_id`,`expiry_date`);--> statement-breakpoint
CREATE INDEX `idx_product_batches_expiry` ON `product_batches` (`expiry_date`);--> statement-breakpoint
CREATE INDEX `idx_product_batches_open` ON `product_batches` (`product_id`,`is_closed`);--> statement-breakpoint
CREATE INDEX `idx_product_batches_source` ON `product_batches` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `stock_ledger_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_id` integer NOT NULL,
	`batch_id` integer NOT NULL,
	`qty_in_milli` integer DEFAULT 0 NOT NULL,
	`qty_out_milli` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ledger_id`) REFERENCES `stock_ledger`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batch_id`) REFERENCES `product_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_stock_ledger_batches_one_direction" CHECK(("stock_ledger_batches"."qty_in_milli" > 0 AND "stock_ledger_batches"."qty_out_milli" = 0)
       OR ("stock_ledger_batches"."qty_in_milli" = 0 AND "stock_ledger_batches"."qty_out_milli" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_stock_ledger_batches` ON `stock_ledger_batches` (`ledger_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_stock_ledger_batches_batch` ON `stock_ledger_batches` (`batch_id`);--> statement-breakpoint
ALTER TABLE `business_settings` ADD `expiry_warning_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `business_settings` ADD `expiry_blocks_sales` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Every product already holding stock gets one undated opening batch.
--
-- Without this, stock exists that belongs to no batch, and picking would run
-- against an incomplete set: a sale could report there is nothing to take while
-- the shelf is full, and — quieter and worse — an expiry warning could be
-- missing for goods about to turn. `verifyBatchCoverage` exists to catch that,
-- and has to be clean from the first moment after this migration.
--
-- `<> 0` rather than `> 0`: a product already negative under
-- `allow_negative_stock` carries that negative into its opening batch, so the
-- coverage invariant holds for it too.
--
-- `opening_qty_milli` is recorded, not derived. This stock predates batches and
-- so has no allocation rows to replay; writing down what the batch began with
-- is what makes `verifyProductBatches` a real check rather than one that can
-- only agree with itself.
--
-- The date is NULL on purpose. As far as the application knows this stock does
-- not expire — a claim the shop can correct per batch. A guessed date would be
-- worse than none: it would warn, or block a sale, on a number nobody entered.
--
-- The `BAT-OPEN-*` refs sit outside the `BAT-#####` sequence deliberately, so
-- the first real delivery still opens `BAT-00001`.
INSERT INTO `product_batches`
  (`product_id`, `batch_ref`, `expiry_date`, `received_date`, `qty_milli`,
   `opening_qty_milli`, `source_type`, `is_closed`, `is_demo`, `created_at`, `updated_at`)
SELECT
  p.`id`,
  'BAT-OPEN-' || printf('%05d', p.`id`),
  NULL,
  date('now'),
  p.`qty_on_hand_milli`,
  p.`qty_on_hand_milli`,
  'OPENING',
  0,
  p.`is_demo`,
  unixepoch() * 1000,
  unixepoch() * 1000
FROM `products` p
WHERE p.`track_inventory` = 1 AND p.`qty_on_hand_milli` <> 0;