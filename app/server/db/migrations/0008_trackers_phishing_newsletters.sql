ALTER TABLE `addresses` ADD `block_promos` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `trackers_removed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `auth_warning` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `is_bulk` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `unsubscribe_url` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `unsubscribe_mailto` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `unsubscribe_one_click` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `unsubscribed_at` integer;