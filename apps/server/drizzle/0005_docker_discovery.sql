ALTER TABLE `proxy_hosts` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `source_ref` text;