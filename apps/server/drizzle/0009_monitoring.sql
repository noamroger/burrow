CREATE TABLE `health_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`up` integer NOT NULL,
	`latency_ms` integer,
	`status_code` integer,
	`error` text,
	FOREIGN KEY (`host_id`) REFERENCES `proxy_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `health_checks_host_time_idx` ON `health_checks` (`host_id`,`checked_at`);--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `badge_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_hosts_badge_token_unique` ON `proxy_hosts` (`badge_token`);