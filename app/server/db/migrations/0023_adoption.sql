CREATE TABLE `site_rejections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`site` text NOT NULL,
	`domain_id` text NOT NULL,
	`address_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_rejections_user_site_domain_uq` ON `site_rejections` (`user_id`,`site`,`domain_id`);--> statement-breakpoint
CREATE INDEX `site_rejections_site_idx` ON `site_rejections` (`site`);--> statement-breakpoint
ALTER TABLE `users` ADD `domain_choice` text DEFAULT 'first' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `no_mail_warn_minutes` integer DEFAULT 15 NOT NULL;