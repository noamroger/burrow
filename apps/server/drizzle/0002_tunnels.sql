CREATE TABLE `tunnels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cf_id` text NOT NULL,
	`name` text NOT NULL,
	`origin` text DEFAULT 'created' NOT NULL,
	`run_connector` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`managed_ingress` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tunnels_cf_id_unique` ON `tunnels` (`cf_id`);--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `tunnel_id` integer REFERENCES tunnels(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `proxy_hosts` ADD `origin_request_extra` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Move the single tunnel of v0.1/v0.2 (stored in settings) into the tunnels table.
INSERT INTO `tunnels` (`cf_id`, `name`, `origin`, `run_connector`, `is_default`, `managed_ingress`)
SELECT
	json_extract(t.`value`, '$'),
	coalesce((SELECT json_extract(n.`value`, '$') FROM `settings` n WHERE n.`key` = 'tunnel.name'), json_extract(t.`value`, '$')),
	'created',
	1,
	1,
	coalesce((SELECT m.`value` FROM `settings` m WHERE m.`key` = 'tunnel.managed_ingress'), '[]')
FROM `settings` t WHERE t.`key` = 'tunnel.id';--> statement-breakpoint
UPDATE `proxy_hosts` SET `tunnel_id` = (SELECT `id` FROM `tunnels` WHERE `is_default` = 1);--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('tunnel.id', 'tunnel.name', 'tunnel.managed_ingress');
