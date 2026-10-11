CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"acting_user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"workspace_tool_id" uuid,
	"mcp_server_id" uuid,
	"arguments" jsonb NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"credential_principal_id" uuid,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_invocations_status_check" CHECK ("tool_invocations"."status" in ('ok', 'rejected', 'denied', 'approval_required', 'failed', 'timeout'))
);
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_invocations_workspace_created_idx" ON "tool_invocations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_invocations_request_id_idx" ON "tool_invocations" USING btree ("request_id");