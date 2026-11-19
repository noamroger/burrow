ALTER TABLE `proxy_hosts` ADD `access_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `access_emails` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `access_email_domains` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `access_session_duration` text DEFAULT '24h' NOT NULL;