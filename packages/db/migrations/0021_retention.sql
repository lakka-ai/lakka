CREATE TABLE "retention_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"spans_days" integer DEFAULT 30 NOT NULL,
	"usage_months" integer DEFAULT 13 NOT NULL,
	"conversations_days" integer,
	"tool_audit_days" integer DEFAULT 90 NOT NULL,
	"budget_alerts_months" integer DEFAULT 13 NOT NULL,
	"reservations_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" uuid,
	"last_run_at" timestamp with time zone,
	"last_run_deleted" jsonb,
	CONSTRAINT "retention_settings_singleton_check" CHECK ("retention_settings"."id"),
	CONSTRAINT "retention_settings_ranges_check" CHECK ("retention_settings"."spans_days" between 1 and 365
        and "retention_settings"."usage_months" between 2 and 120
        and ("retention_settings"."conversations_days" is null or "retention_settings"."conversations_days" between 1 and 3650)
        and "retention_settings"."tool_audit_days" between 1 and 3650
        and "retention_settings"."budget_alerts_months" between 1 and 120
        and "retention_settings"."reservations_days" between 1 and 365)
);

--> statement-breakpoint
-- The one row of instance settings, with the documented defaults (ADR 0078).
INSERT INTO "retention_settings" ("id") VALUES (true);
