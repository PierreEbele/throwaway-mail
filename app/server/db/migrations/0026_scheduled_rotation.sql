ALTER TABLE `addresses` ADD `rotation_mode` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `addresses` ADD `rotation_days` integer;--> statement-breakpoint
ALTER TABLE `addresses` ADD `rotation_grace_days` integer;--> statement-breakpoint
ALTER TABLE `addresses` ADD `rotation_grace_until` integer;--> statement-breakpoint
ALTER TABLE `addresses` ADD `rotated_to_id` text;