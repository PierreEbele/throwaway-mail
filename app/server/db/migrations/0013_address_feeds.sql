ALTER TABLE `addresses` ADD `feed_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `addresses_feed_token_unique` ON `addresses` (`feed_token`);