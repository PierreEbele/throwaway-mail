CREATE TABLE `address_destinations` (
	`address_id` text NOT NULL,
	`destination_id` text NOT NULL,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `address_destinations_uq` ON `address_destinations` (`address_id`,`destination_id`);