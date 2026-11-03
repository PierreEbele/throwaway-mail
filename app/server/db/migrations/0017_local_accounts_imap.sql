CREATE TABLE `domain_mailboxes` (
	`domain_id` text PRIMARY KEY NOT NULL,
	`imap_host` text NOT NULL,
	`imap_port` integer DEFAULT 993 NOT NULL,
	`imap_tls` integer DEFAULT true NOT NULL,
	`imap_user` text NOT NULL,
	`imap_password_enc` text NOT NULL,
	`imap_folder` text DEFAULT 'INBOX' NOT NULL,
	`imap_done_folder` text DEFAULT 'Processed',
	`smtp_host` text,
	`smtp_port` integer DEFAULT 465,
	`smtp_security` text DEFAULT 'tls',
	`smtp_user` text,
	`smtp_password_enc` text,
	`smtp_from` text,
	`poll_seconds` integer DEFAULT 60 NOT NULL,
	`last_poll_at` integer,
	`last_poll_error` text,
	`last_uid` integer DEFAULT 0 NOT NULL,
	`uid_validity` integer,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`oidc_sub` text,
	`password_hash` text,
	`email` text NOT NULL,
	`name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "oidc_sub", "password_hash", "email", "name", "role", "disabled", "created_at", "last_login_at") SELECT "id", "oidc_sub", NULL, "email", "name", "role", "disabled", "created_at", "last_login_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_sub_unique` ON `users` (`oidc_sub`);--> statement-breakpoint
ALTER TABLE `destinations` ADD `verify_token_hash` text;--> statement-breakpoint
ALTER TABLE `destinations` ADD `verify_sent_at` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `transport` text DEFAULT 'cloudflare' NOT NULL;