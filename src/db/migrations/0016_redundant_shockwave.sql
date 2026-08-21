PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_purchase_taxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`component_id` integer,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`basis` text DEFAULT 'NET' NOT NULL,
	`amount_minor` integer NOT NULL,
	`is_recoverable` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_id`) REFERENCES `tax_components`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_purchase_taxes_basis" CHECK("__new_purchase_taxes"."basis" IN ('NET', 'NET_PLUS_LEVIES'))
);
--> statement-breakpoint
INSERT INTO `__new_purchase_taxes`("id", "purchase_id", "component_id", "code", "name", "rate_bp", "basis", "amount_minor", "is_recoverable", "created_at") SELECT "id", "purchase_id", "component_id", "code", "name", "rate_bp", 'NET', "amount_minor", "is_recoverable", "created_at" FROM `purchase_taxes`;--> statement-breakpoint
DROP TABLE `purchase_taxes`;--> statement-breakpoint
ALTER TABLE `__new_purchase_taxes` RENAME TO `purchase_taxes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_purchase_taxes_purchase` ON `purchase_taxes` (`purchase_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_purchase_taxes_purchase_code` ON `purchase_taxes` (`purchase_id`,`code`);--> statement-breakpoint
CREATE TABLE `__new_sale_taxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`component_id` integer,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_bp` integer NOT NULL,
	`basis` text DEFAULT 'NET' NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_id`) REFERENCES `tax_components`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_sale_taxes_basis" CHECK("__new_sale_taxes"."basis" IN ('NET', 'NET_PLUS_LEVIES'))
);
--> statement-breakpoint
INSERT INTO `__new_sale_taxes`("id", "sale_id", "component_id", "code", "name", "rate_bp", "basis", "amount_minor", "created_at") SELECT "id", "sale_id", "component_id", "code", "name", "rate_bp", 'NET', "amount_minor", "created_at" FROM `sale_taxes`;--> statement-breakpoint
DROP TABLE `sale_taxes`;--> statement-breakpoint
ALTER TABLE `__new_sale_taxes` RENAME TO `sale_taxes`;--> statement-breakpoint
CREATE INDEX `idx_sale_taxes_sale` ON `sale_taxes` (`sale_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sale_taxes_sale_code` ON `sale_taxes` (`sale_id`,`code`);--> statement-breakpoint
CREATE TABLE `__new_tax_components` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_bp` integer DEFAULT 0 NOT NULL,
	`basis` text DEFAULT 'NET' NOT NULL,
	`is_recoverable` integer DEFAULT false NOT NULL,
	`gl_account_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`gl_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_tax_components_rate" CHECK("__new_tax_components"."rate_bp" >= 0 AND "__new_tax_components"."rate_bp" <= 100000),
	CONSTRAINT "ck_tax_components_basis" CHECK("__new_tax_components"."basis" IN ('NET', 'NET_PLUS_LEVIES')),
	CONSTRAINT "ck_tax_components_code" CHECK(length("__new_tax_components"."code") > 0),
	CONSTRAINT "ck_tax_components_name" CHECK(length("__new_tax_components"."name") > 0)
);
--> statement-breakpoint
INSERT INTO `__new_tax_components`("id", "code", "name", "rate_bp", "basis", "is_recoverable", "gl_account_id", "sort_order", "is_active", "created_at", "updated_at") SELECT "id", "code", "name", "rate_bp", 'NET', "is_recoverable", "gl_account_id", "sort_order", "is_active", "created_at", "updated_at" FROM `tax_components`;--> statement-breakpoint
DROP TABLE `tax_components`;--> statement-breakpoint
ALTER TABLE `__new_tax_components` RENAME TO `tax_components`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tax_components_code` ON `tax_components` (`code`);--> statement-breakpoint
CREATE INDEX `idx_tax_components_active` ON `tax_components` (`is_active`);