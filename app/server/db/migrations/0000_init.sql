CREATE TABLE `address_destinations` (
	`address_id` text NOT NULL,
	`destination_id` text NOT NULL,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `address_destinations_uq` ON `address_destinations` (`address_id`,`destination_id`);--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`site_name` text NOT NULL,
	`site_url` text,
	`label` text,
	`forward_enabled` integer DEFAULT false NOT NULL,
	`destination_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`is_unassigned` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer,
	`category_id` text,
	`pinned` integer DEFAULT false NOT NULL,
	`stale_dismissed_at` integer,
	`blocked_senders_json` text,
	`trusted_senders_json` text,
	`leak_sender` text,
	`leak_at` integer,
	`block_promos` integer DEFAULT false NOT NULL,
	`site_lock` integer DEFAULT false NOT NULL,
	`max_messages` integer,
	`burn_after_code` integer DEFAULT false NOT NULL,
	`burn_reason` text,
	`burned_at` integer,
	`expiry_reminded_at` integer,
	`replies_enabled` integer DEFAULT false NOT NULL,
	`feed_token` text,
	`fallback_destination_ids_json` text,
	`rotation_mode` text DEFAULT 'default' NOT NULL,
	`rotation_days` integer,
	`rotation_grace_days` integer,
	`rotation_grace_until` integer,
	`rotated_to_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `destinations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `addresses_feed_token_unique` ON `addresses` (`feed_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `addresses_domain_local_uq` ON `addresses` (`domain_id`,`local_part`);--> statement-breakpoint
CREATE INDEX `addresses_user_idx` ON `addresses` (`user_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`scope` text DEFAULT 'full' NOT NULL,
	`address_ids` text,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`target` text,
	`meta_json` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_user_idx` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_log` (`action`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'zinc' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`auto_match` text,
	`retention_days` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_name_uq` ON `categories` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `delivery_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address_id` text,
	`message_id` text,
	`destination` text NOT NULL,
	`transport` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`delivered_to` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`last_retry_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `delivery_failures_user_idx` ON `delivery_failures` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `delivery_failures_message_idx` ON `delivery_failures` (`message_id`);--> statement-breakpoint
CREATE TABLE `destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`cf_destination_id` text,
	`verified_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`pgp_public_key` text,
	`pgp_fingerprint` text,
	`verify_token_hash` text,
	`verify_sent_at` integer,
	`pgp_hide_subject` integer DEFAULT false NOT NULL,
	`fallback_position` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `destinations_user_email_uq` ON `destinations` (`user_id`,`email`);--> statement-breakpoint
CREATE TABLE `directories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directories_name_unique` ON `directories` (`name`);--> statement-breakpoint
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
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text DEFAULT 'cloudflare' NOT NULL,
	`cf_zone_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_detail` text,
	`dns_missing_json` text,
	`unknown_policy` text DEFAULT 'reject' NOT NULL,
	`auto_create_user_id` text,
	`auto_create_category_id` text,
	`previous_catch_all_json` text,
	`catchall_forward_to` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_checked_at` integer,
	`last_ingest_at` integer,
	FOREIGN KEY (`auto_create_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`auto_create_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_name_unique` ON `domains` (`name`);--> statement-breakpoint
CREATE TABLE `extracted_items` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`confidence` real NOT NULL,
	`method` text NOT NULL,
	`label` text,
	`rank` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extracted_message_idx` ON `extracted_items` (`message_id`);--> statement-breakpoint
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
CREATE TABLE `leak_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address_id` text NOT NULL,
	`sender` text NOT NULL,
	`sender_domain` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `leak_events_user_idx` ON `leak_events` (`user_id`,`sender_domain`);--> statement-breakpoint
CREATE INDEX `leak_events_address_idx` ON `leak_events` (`address_id`);--> statement-breakpoint
CREATE TABLE `login_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_raw` (
	`message_id` text PRIMARY KEY NOT NULL,
	`raw` blob NOT NULL,
	`keep_until` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` text NOT NULL,
	`user_id` text NOT NULL,
	`message_id_header` text,
	`envelope_from` text,
	`envelope_to` text NOT NULL,
	`from_addr` text,
	`from_name` text,
	`subject` text,
	`received_at` integer NOT NULL,
	`text` text,
	`html` text,
	`raw_size` integer NOT NULL,
	`headers_json` text,
	`spf` text,
	`dkim` text,
	`dmarc` text,
	`read_at` integer,
	`archived_at` integer,
	`forwarded` integer DEFAULT false NOT NULL,
	`forward_to` text,
	`body_hash` text,
	`attachments_json` text,
	`trackers_removed` integer DEFAULT 0 NOT NULL,
	`auth_warning` text,
	`is_bulk` integer DEFAULT false NOT NULL,
	`unsubscribe_url` text,
	`unsubscribe_mailto` text,
	`unsubscribe_one_click` integer DEFAULT false NOT NULL,
	`unsubscribed_at` integer,
	`raw_headers` text,
	`matched_rules_json` text,
	`quarantined_at` integer,
	`strip_attachments` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_address_msgid_uq` ON `messages` (`address_id`,`message_id_header`);--> statement-breakpoint
CREATE INDEX `messages_address_received_idx` ON `messages` (`address_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `messages_user_idx` ON `messages` (`user_id`);--> statement-breakpoint
CREATE INDEX `messages_received_idx` ON `messages` (`received_at`);--> statement-breakpoint
CREATE TABLE `notify_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`token` text,
	`chat_id` text,
	`secret` text,
	`events_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_ok_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`paused_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notify_targets_user_idx` ON `notify_targets` (`user_id`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports_json` text,
	`device_type` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recovery_codes_user_idx` ON `recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `reverse_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`token` text NOT NULL,
	`blocked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_reply_at` integer,
	`reply_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reverse_contacts_token_unique` ON `reverse_contacts` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `reverse_contacts_address_email_uq` ON `reverse_contacts` (`address_id`,`email`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address_id` text,
	`category_id` text,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`match` text DEFAULT 'all' NOT NULL,
	`conditions_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`match_count` integer DEFAULT 0 NOT NULL,
	`last_matched_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rules_user_idx` ON `rules` (`user_id`,`position`);--> statement-breakpoint
CREATE TABLE `saved_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`params_json` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_searches_user_idx` ON `saved_searches` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
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
CREATE TABLE `smtp_passwords` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`hint` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `smtp_passwords_password_hash_unique` ON `smtp_passwords` (`password_hash`);--> statement-breakpoint
CREATE INDEX `smtp_passwords_user_idx` ON `smtp_passwords` (`user_id`);--> statement-breakpoint
CREATE TABLE `system_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`oidc_sub` text,
	`password_hash` text,
	`email` text NOT NULL,
	`name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	`totp_secret` text,
	`totp_enabled_at` integer,
	`totp_last_step` integer,
	`forward_header_allowlist_json` text,
	`domain_choice` text DEFAULT 'first' NOT NULL,
	`no_mail_warn_minutes` integer DEFAULT 15 NOT NULL,
	`passkey_second_factor` integer DEFAULT false NOT NULL,
	`address_settings_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_sub_unique` ON `users` (`oidc_sub`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`purpose` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`target_id`) REFERENCES `notify_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_target_idx` ON `webhook_deliveries` (`target_id`,`created_at`);