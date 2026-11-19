ALTER TABLE `audit_log` ADD `actor` text DEFAULT 'System' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `ip` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `category` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `details` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `undo` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `undone_at` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `undone_by_id` integer;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `revert_of` integer;--> statement-breakpoint
CREATE INDEX `audit_log_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_category_idx` ON `audit_log` (`category`);--> statement-breakpoint
UPDATE `audit_log` SET `category` = substr(`action`, 1, instr(`action` || '.', '.') - 1);--> statement-breakpoint
UPDATE `audit_log` SET `actor` = COALESCE((SELECT `email` FROM `users` WHERE `users`.`id` = `audit_log`.`user_id`), 'System');
