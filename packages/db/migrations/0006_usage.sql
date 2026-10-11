-- Partitioned by month; drizzle-kit cannot express PARTITION BY, so it is added by hand here.
-- Monthly partitions are created by ensureUsagePartitions (ADR 0039).
CREATE TABLE "usage" (
	"id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"attempt" smallint NOT NULL,
	"outcome" text NOT NULL,
	"surface" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"acting_user_id" uuid NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"provider_config_id" uuid,
	"input_tokens" integer NOT NULL,
	"uncached_input_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"reasoning_tokens" integer,
	"usage_estimated" boolean NOT NULL,
	"input_micro_usd_per_mtok" bigint NOT NULL,
	"output_micro_usd_per_mtok" bigint NOT NULL,
	"cache_read_micro_usd_per_mtok" bigint NOT NULL,
	"cache_write_micro_usd_per_mtok" bigint NOT NULL,
	"price_tier_above_input_tokens" integer,
	"cost_micro_usd" bigint NOT NULL,
	"finish_reason" text,
	"latency_ms" integer NOT NULL,
	"ttft_ms" integer,
	CONSTRAINT "usage_pkey" PRIMARY KEY("id","created_at"),
	CONSTRAINT "usage_outcome_check" CHECK ("usage"."outcome" in ('completed', 'interrupted', 'aborted', 'abandoned')),
	CONSTRAINT "usage_surface_check" CHECK ("usage"."surface" in ('chat', 'api', 'mcp')),
	CONSTRAINT "usage_tokens_check" CHECK ("usage"."uncached_input_tokens" >= 0 and "usage"."cache_read_tokens" >= 0 and "usage"."cache_write_tokens" >= 0
        and "usage"."output_tokens" >= 0
        and "usage"."input_tokens" = "usage"."uncached_input_tokens" + "usage"."cache_read_tokens" + "usage"."cache_write_tokens"),
	CONSTRAINT "usage_cost_check" CHECK ("usage"."cost_micro_usd" >= 0)
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE INDEX "usage_workspace_created_idx" ON "usage" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_acting_user_created_idx" ON "usage" USING btree ("acting_user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_request_idx" ON "usage" USING btree ("request_id");