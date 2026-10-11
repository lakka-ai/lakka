CREATE TABLE "mcp_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"principal_kind" text GENERATED ALWAYS AS ('user') STORED,
	"code_verifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mcp_oauth_states_state_hash_check" CHECK ("mcp_oauth_states"."state_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_source" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_scope" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_principal_is_user_fkey" FOREIGN KEY ("principal_id","principal_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_oauth_states_expires_at_idx" ON "mcp_oauth_states" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_oauth_check" CHECK (("mcp_servers"."auth_mode" = 'oauth' or ("mcp_servers"."oauth_client" is null and "mcp_servers"."oauth_scope" is null))
        and ("mcp_servers"."oauth_client" is null) = ("mcp_servers"."oauth_client_source" is null));