ALTER TABLE `proxy_hosts` ADD `maintenance_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `maintenance_until` text;--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `maintenance_page` text;