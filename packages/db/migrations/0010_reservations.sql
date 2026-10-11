CREATE TABLE "reservation_lines" (
	"reservation_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	CONSTRAINT "reservation_lines_pkey" PRIMARY KEY("reservation_id","budget_id")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"acting_user_id" uuid NOT NULL,
	"amount_micro_usd" bigint NOT NULL,
	"state" text NOT NULL,
	"actual_micro_usd" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "reservations_state_check" CHECK ("reservations"."state" in ('pending', 'active', 'denied', 'settled', 'abandoned')),
	CONSTRAINT "reservations_amount_check" CHECK ("reservations"."amount_micro_usd" >= 0),
	CONSTRAINT "reservations_actual_check" CHECK (("reservations"."state" in ('settled', 'abandoned')) = ("reservations"."actual_micro_usd" is not null)
        and ("reservations"."actual_micro_usd" is null or "reservations"."actual_micro_usd" >= 0)
        and ("reservations"."state" in ('settled', 'abandoned')) = ("reservations"."settled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "budgets" DROP CONSTRAINT "budgets_limit_check";--> statement-breakpoint
ALTER TABLE "reservation_lines" ADD CONSTRAINT "reservation_lines_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_lines" ADD CONSTRAINT "reservation_lines_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservation_lines_budget_period_idx" ON "reservation_lines" USING btree ("budget_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_request_live_key" ON "reservations" USING btree ("request_id") WHERE "reservations"."state" <> 'denied';--> statement-breakpoint
CREATE INDEX "reservations_state_expires_idx" ON "reservations" USING btree ("state","expires_at");--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_limit_check" CHECK ("budgets"."limit_micro_usd" >= 0 and "budgets"."limit_micro_usd" <= 999999999999999);