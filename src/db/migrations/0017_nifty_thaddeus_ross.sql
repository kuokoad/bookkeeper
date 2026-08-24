ALTER TABLE `sales` ADD `client_ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sales_client_ref` ON `sales` (`client_ref`);