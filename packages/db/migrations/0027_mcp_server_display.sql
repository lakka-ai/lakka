ALTER TABLE "mcp_servers" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_sync_error" text;