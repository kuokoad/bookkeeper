ALTER TABLE `business_settings` ADD `default_terms_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ADD `invoice_no` text;--> statement-breakpoint
ALTER TABLE `sales` ADD `terms_days` integer;--> statement-breakpoint
ALTER TABLE `sales` ADD `due_date` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sales_invoice_no` ON `sales` (`invoice_no`);--> statement-breakpoint
CREATE INDEX `idx_sales_due_date` ON `sales` (`due_date`);