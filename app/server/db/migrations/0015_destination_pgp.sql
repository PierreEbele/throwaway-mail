ALTER TABLE `destinations` ADD `pgp_public_key` text;--> statement-breakpoint
ALTER TABLE `destinations` ADD `pgp_fingerprint` text;--> statement-breakpoint
ALTER TABLE `destinations` ADD `pgp_hide_subject` integer DEFAULT false NOT NULL;