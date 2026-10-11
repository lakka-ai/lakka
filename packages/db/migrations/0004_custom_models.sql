CREATE TABLE "custom_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_ref" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"context_window" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"capabilities" jsonb NOT NULL,
	"input_micro_usd_per_mtok" bigint NOT NULL,
	"output_micro_usd_per_mtok" bigint NOT NULL,
	"cache_read_micro_usd_per_mtok" bigint,
	"cache_write_micro_usd_per_mtok" bigint,
	"created_by_principal_id" uuid NOT NULL,
	"created_by_kind" text GENERATED ALWAYS AS ('user') STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_models_model_ref_key" UNIQUE("model_ref"),
	CONSTRAINT "custom_models_ref_check" CHECK ("custom_models"."model_ref" = "custom_models"."provider" || ':' || "custom_models"."model"),
	CONSTRAINT "custom_models_provider_check" CHECK ("custom_models"."provider" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
	CONSTRAINT "custom_models_limits_check" CHECK ("custom_models"."context_window" > 0 and "custom_models"."max_output_tokens" > 0),
	CONSTRAINT "custom_models_prices_check" CHECK ("custom_models"."input_micro_usd_per_mtok" >= 0 and "custom_models"."output_micro_usd_per_mtok" >= 0
        and coalesce("custom_models"."cache_read_micro_usd_per_mtok", 0) >= 0
        and coalesce("custom_models"."cache_write_micro_usd_per_mtok", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "custom_models" ADD CONSTRAINT "custom_models_created_by_is_user_fkey" FOREIGN KEY ("created_by_principal_id","created_by_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;