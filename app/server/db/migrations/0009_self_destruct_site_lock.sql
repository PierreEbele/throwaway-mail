ALTER TABLE `addresses` ADD `site_lock` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `addresses` ADD `max_messages` integer;--> statement-breakpoint
ALTER TABLE `addresses` ADD `burn_after_code` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `addresses` ADD `burn_reason` text;--> statement-breakpoint
ALTER TABLE `addresses` ADD `burned_at` integer;