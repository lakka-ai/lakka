CREATE TABLE "tool_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"tool_invocation_id" uuid NOT NULL,
	"workspace_tool_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"call_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_principal_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_approvals_status_check" CHECK ("tool_approvals"."status" in ('pending', 'approved', 'denied', 'expired')),
	CONSTRAINT "tool_approvals_decided_check" CHECK (("tool_approvals"."status" in ('approved', 'denied')) = ("tool_approvals"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tool_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"workspace_tool_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_principal_id" uuid,
	CONSTRAINT "tool_grants_revoked_check" CHECK (("tool_grants"."revoked_at" is null) = ("tool_grants"."revoked_by_principal_id" is null))
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_role_check";--> statement-breakpoint
DROP INDEX "reservations_request_live_key";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_calls" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_error" boolean;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_workspace_tool_id_workspace_tools_id_fk" FOREIGN KEY ("workspace_tool_id") REFERENCES "public"."workspace_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_approvals_pending_key" ON "tool_approvals" USING btree ("conversation_id") WHERE "tool_approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tool_approvals_workspace_idx" ON "tool_approvals" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_grants_active_key" ON "tool_grants" USING btree ("principal_id","workspace_tool_id") WHERE "tool_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "tool_grants_workspace_idx" ON "tool_grants" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_request_live_key" ON "reservations" USING btree ("request_id") WHERE "reservations"."state" in ('pending', 'active');--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tool_check" CHECK (("messages"."role" = 'tool') = ("messages"."tool_call_id" is not null and "messages"."tool_name" is not null)
        and ("messages"."tool_calls" is null or "messages"."role" = 'assistant'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant', 'tool'));