CREATE TABLE "route_candidate_decisions" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"route_id" uuid,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_candidate_decisions_decision_check" CHECK ("route_candidate_decisions"."decision" in ('added', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "route_candidate_decisions" ADD CONSTRAINT "route_candidate_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_candidate_decisions" ADD CONSTRAINT "route_candidate_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_candidate_decisions" ADD CONSTRAINT "route_candidate_decisions_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_candidate_decisions" ADD CONSTRAINT "route_candidate_decisions_decided_by_principals_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_candidate_decisions_workspace_idx" ON "route_candidate_decisions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_request_idx" ON "messages" USING btree ("request_id");