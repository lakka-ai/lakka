CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"principal_kind" text GENERATED ALWAYS AS ('user') STORED,
	"route_id" uuid,
	"routed_model" text,
	"route_decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_decision_check" CHECK (("conversations"."routed_model" is null) = ("conversations"."route_decided_at" is null)
        and ("conversations"."route_id" is null or "conversations"."routed_model" is not null))
);
--> statement-breakpoint
-- Usage recorded before routing existed came from callers that named the model themselves
-- (M2 dispatch), which is what 'explicit' means. New rows must always say which rule decided.
ALTER TABLE "usage" ADD COLUMN "resolution_rule" text DEFAULT 'explicit' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage" ALTER COLUMN "resolution_rule" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "route_id" uuid;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "route_confidence" double precision;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "default_reason" text;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "was_overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage" ADD COLUMN "overridden_model" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_principal_is_user_fkey" FOREIGN KEY ("principal_id","principal_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_workspace_principal_idx" ON "conversations" USING btree ("workspace_id","principal_id");--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_resolution_rule_check" CHECK ("usage"."resolution_rule" in ('explicit', 'sticky', 'pinned', 'signal', 'classified', 'default'));--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_default_reason_check" CHECK (("usage"."default_reason" is null) = ("usage"."resolution_rule" <> 'default')
        and ("usage"."default_reason" is null or "usage"."default_reason" in
          ('routing_off', 'no_routes', 'too_short', 'classifier_unavailable', 'below_threshold', 'ambiguous')));--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_override_check" CHECK ("usage"."was_overridden" = ("usage"."overridden_model" is not null)
        and (not "usage"."was_overridden" or "usage"."resolution_rule" = 'explicit'));--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_route_confidence_check" CHECK ("usage"."route_confidence" is null or "usage"."route_confidence" between -1 and 1);