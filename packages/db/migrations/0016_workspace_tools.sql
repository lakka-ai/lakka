CREATE TABLE "workspace_tools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"description" text,
	"input_schema" jsonb NOT NULL,
	"annotations" jsonb NOT NULL,
	"unusable_reason" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"approval_required" boolean NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_tools_server_name_key" UNIQUE("mcp_server_id","name"),
	CONSTRAINT "workspace_tools_unusable_check" CHECK ("workspace_tools"."unusable_reason" is null or not "workspace_tools"."enabled"),
	CONSTRAINT "workspace_tools_unusable_reason_check" CHECK ("workspace_tools"."unusable_reason" in ('schema'))
);
--> statement-breakpoint
ALTER TABLE "workspace_tools" ADD CONSTRAINT "workspace_tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tools" ADD CONSTRAINT "workspace_tools_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_tools_workspace_id_idx" ON "workspace_tools" USING btree ("workspace_id");