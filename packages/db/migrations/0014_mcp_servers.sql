CREATE TABLE "mcp_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"principal_kind" text GENERATED ALWAYS AS ('user') STORED,
	"kind" text NOT NULL,
	"secret" text NOT NULL,
	"refresh_secret" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_credentials_kind_check" CHECK ("mcp_credentials"."kind" in ('shared', 'user'))
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_env" text,
	"auth_mode" text NOT NULL,
	"allow_private" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_status" text,
	"created_by_principal_id" uuid NOT NULL,
	"created_by_kind" text GENERATED ALWAYS AS ('user') STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_workspace_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "mcp_servers_name_check" CHECK ("mcp_servers"."name" ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'),
	CONSTRAINT "mcp_servers_transport_check" CHECK ("mcp_servers"."transport" in ('stdio', 'streamable_http')),
	CONSTRAINT "mcp_servers_auth_mode_check" CHECK ("mcp_servers"."auth_mode" in ('none', 'shared', 'oauth')),
	CONSTRAINT "mcp_servers_target_check" CHECK (case when "mcp_servers"."transport" = 'stdio'
        then "mcp_servers"."command" is not null and "mcp_servers"."url" is null and "mcp_servers"."auth_mode" <> 'oauth'
          and ("mcp_servers"."credential_env" is not null) = ("mcp_servers"."auth_mode" = 'shared')
        else "mcp_servers"."url" is not null and "mcp_servers"."command" is null and "mcp_servers"."credential_env" is null
          and "mcp_servers"."args" = '[]'::jsonb end),
	CONSTRAINT "mcp_servers_credential_env_check" CHECK ("mcp_servers"."credential_env" is null or "mcp_servers"."credential_env" ~ '^[A-Z_][A-Z0-9_]{0,63}$'),
	CONSTRAINT "mcp_servers_test_check" CHECK (("mcp_servers"."last_tested_at" is null) = ("mcp_servers"."last_test_status" is null))
);
--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_principal_is_user_fkey" FOREIGN KEY ("principal_id","principal_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_is_user_fkey" FOREIGN KEY ("created_by_principal_id","created_by_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credentials_shared_key" ON "mcp_credentials" USING btree ("mcp_server_id") WHERE "mcp_credentials"."kind" = 'shared';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credentials_user_key" ON "mcp_credentials" USING btree ("mcp_server_id","principal_id") WHERE "mcp_credentials"."kind" = 'user';--> statement-breakpoint
CREATE INDEX "mcp_servers_workspace_id_idx" ON "mcp_servers" USING btree ("workspace_id");