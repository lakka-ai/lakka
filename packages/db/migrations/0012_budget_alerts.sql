CREATE TABLE "alert_webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_webhooks_workspace_key" UNIQUE NULLS NOT DISTINCT("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"budget_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"percent" smallint NOT NULL,
	"spent_micro_usd" bigint NOT NULL,
	"limit_micro_usd" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "budget_alerts_once_key" UNIQUE("budget_id","period_start","percent"),
	CONSTRAINT "budget_alerts_state_check" CHECK ("budget_alerts"."state" in ('pending', 'enqueued', 'delivered', 'failed', 'no_destination'))
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "alert_percents" smallint[] DEFAULT '{80,100}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_webhooks" ADD CONSTRAINT "alert_webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_alerts_state_idx" ON "budget_alerts" USING btree ("state","created_at");--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_alert_percents_check" CHECK (cardinality("budgets"."alert_percents") <= 5);