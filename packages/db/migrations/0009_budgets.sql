CREATE TABLE "budget_spend" (
	"budget_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_spend_pkey" PRIMARY KEY("budget_id","period_start"),
	CONSTRAINT "budget_spend_spent_check" CHECK ("budget_spend"."spent_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"workspace_id" uuid,
	"principal_id" uuid,
	"limit_micro_usd" bigint NOT NULL,
	"period" text NOT NULL,
	"updated_by_principal_id" uuid NOT NULL,
	"updated_by_kind" text GENERATED ALWAYS AS ('user') STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_target_key" UNIQUE NULLS NOT DISTINCT("scope","workspace_id","principal_id"),
	CONSTRAINT "budgets_scope_check" CHECK ("budgets"."scope" in ('instance', 'workspace', 'member', 'key')),
	CONSTRAINT "budgets_period_check" CHECK ("budgets"."period" in ('daily', 'monthly', 'none')),
	CONSTRAINT "budgets_limit_check" CHECK ("budgets"."limit_micro_usd" >= 0 and "budgets"."limit_micro_usd" <= 9999999999999999),
	CONSTRAINT "budgets_target_check" CHECK (("budgets"."scope" = 'instance' and "budgets"."workspace_id" is null and "budgets"."principal_id" is null)
        or ("budgets"."scope" = 'workspace' and "budgets"."workspace_id" is not null and "budgets"."principal_id" is null)
        or ("budgets"."scope" in ('member', 'key') and "budgets"."workspace_id" is not null and "budgets"."principal_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "budget_spend" ADD CONSTRAINT "budget_spend_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_updated_by_is_user_fkey" FOREIGN KEY ("updated_by_principal_id","updated_by_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budgets_workspace_id_idx" ON "budgets" USING btree ("workspace_id");