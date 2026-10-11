CREATE TABLE "provider_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"api_key" text,
	"last_tested_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_http_status" integer,
	"created_by_principal_id" uuid NOT NULL,
	"created_by_kind" text GENERATED ALWAYS AS ('user') STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_configs_scope_name_key" UNIQUE NULLS NOT DISTINCT("workspace_id","name"),
	CONSTRAINT "provider_configs_kind_check" CHECK ("provider_configs"."kind" in ('anthropic', 'openai', 'google', 'openai-compatible')),
	CONSTRAINT "provider_configs_name_check" CHECK (case when "provider_configs"."kind" = 'openai-compatible'
        then "provider_configs"."name" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'
          and "provider_configs"."name" not in ('anthropic', 'openai', 'google')
          and "provider_configs"."base_url" is not null
        else "provider_configs"."name" = "provider_configs"."kind" and "provider_configs"."api_key" is not null end),
	CONSTRAINT "provider_configs_workspace_scope_check" CHECK ("provider_configs"."workspace_id" is null or ("provider_configs"."kind" <> 'openai-compatible' and "provider_configs"."base_url" is null)),
	CONSTRAINT "provider_configs_test_check" CHECK (("provider_configs"."last_tested_at" is null) = ("provider_configs"."last_test_status" is null))
);
--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_created_by_is_user_fkey" FOREIGN KEY ("created_by_principal_id","created_by_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_configs_workspace_id_idx" ON "provider_configs" USING btree ("workspace_id");