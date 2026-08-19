CREATE TABLE `purchase_taxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`component_id` integer,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`is_recoverable` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_id`) REFERENCES `tax_components`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_purchase_taxes_purchase` ON `purchase_taxes` (`purchase_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_taxes_purchase_code` ON `purchase_taxes` (`purchase_id`,`code`);--> statement-breakpoint
CREATE TABLE `sale_taxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`component_id` integer,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_id`) REFERENCES `tax_components`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sale_taxes_sale` ON `sale_taxes` (`sale_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sale_taxes_sale_code` ON `sale_taxes` (`sale_id`,`code`);--> statement-breakpoint
CREATE TABLE `tax_components` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_bp` integer DEFAULT 0 NOT NULL,
	`is_recoverable` integer DEFAULT false NOT NULL,
	`gl_account_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`gl_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_tax_components_rate" CHECK("tax_components"."rate_bp" >= 0 AND "tax_components"."rate_bp" <= 100000),
	CONSTRAINT "ck_tax_components_code" CHECK(length("tax_components"."code") > 0),
	CONSTRAINT "ck_tax_components_name" CHECK(length("tax_components"."name") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tax_components_code` ON `tax_components` (`code`);--> statement-breakpoint
CREATE INDEX `idx_tax_components_active` ON `tax_components` (`is_active`);