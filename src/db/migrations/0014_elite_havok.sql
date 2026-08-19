PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`receipt_no` text NOT NULL,
	`kind` text DEFAULT 'SALE' NOT NULL,
	`returns_sale_id` integer,
	`business_date` text NOT NULL,
	`invoice_no` text,
	`terms_days` integer,
	`due_date` text,
	`occurred_at` integer NOT NULL,
	`customer_id` integer,
	`subtotal_minor` integer NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer NOT NULL,
	`tax_inclusive` integer DEFAULT false NOT NULL,
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
	CONSTRAINT "ck_sales_signs_consistent" CHECK((
        "__new_sales"."subtotal_minor" >= 0 AND "__new_sales"."discount_minor" >= 0
        AND "__new_sales"."tax_minor" >= 0 AND "__new_sales"."total_minor" >= 0
      ) OR (
        "__new_sales"."subtotal_minor" <= 0 AND "__new_sales"."discount_minor" <= 0
        AND "__new_sales"."tax_minor" <= 0 AND "__new_sales"."total_minor" <= 0
      )),
	CONSTRAINT "ck_sales_total_arithmetic" CHECK("__new_sales"."total_minor" = "__new_sales"."subtotal_minor" - "__new_sales"."discount_minor" + "__new_sales"."tax_minor"),
	CONSTRAINT "ck_sales_not_self_voiding" CHECK("__new_sales"."voids_sale_id" IS NULL OR "__new_sales"."voids_sale_id" <> "__new_sales"."id"),
	CONSTRAINT "ck_sales_kind" CHECK("__new_sales"."kind" IN ('SALE', 'RETURN', 'VOID')),
	CONSTRAINT "ck_sales_not_self_returning" CHECK("__new_sales"."returns_sale_id" IS NULL OR "__new_sales"."returns_sale_id" <> "__new_sales"."id")
);
--> statement-breakpoint
INSERT INTO `__new_sales`("id", "receipt_no", "kind", "returns_sale_id", "business_date", "invoice_no", "terms_days", "due_date", "occurred_at", "customer_id", "subtotal_minor", "discount_minor", "tax_minor", "total_minor", "tax_inclusive", "cogs_minor", "status", "journal_entry_id", "voided_by_sale_id", "voids_sale_id", "voided_at", "void_reason", "note", "created_by", "is_demo", "created_at", "updated_at") SELECT "id", "receipt_no", "kind", "returns_sale_id", "business_date", "invoice_no", "terms_days", "due_date", "occurred_at", "customer_id", "subtotal_minor", "discount_minor", "tax_minor", "total_minor", "tax_inclusive", "cogs_minor", "status", "journal_entry_id", "voided_by_sale_id", "voids_sale_id", "voided_at", "void_reason", "note", "created_by", "is_demo", "created_at", "updated_at" FROM `sales`;--> statement-breakpoint
DROP TABLE `sales`;--> statement-breakpoint
ALTER TABLE `__new_sales` RENAME TO `sales`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sales_receipt_no` ON `sales` (`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sales_invoice_no` ON `sales` (`invoice_no`);--> statement-breakpoint
CREATE INDEX `idx_sales_due_date` ON `sales` (`due_date`);--> statement-breakpoint
CREATE INDEX `idx_sales_date` ON `sales` (`business_date`);--> statement-breakpoint
CREATE INDEX `idx_sales_customer` ON `sales` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_status` ON `sales` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sales_occurred` ON `sales` (`occurred_at`);