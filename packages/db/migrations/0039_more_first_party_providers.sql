ALTER TABLE "provider_configs" DROP CONSTRAINT "provider_configs_kind_check";--> statement-breakpoint
ALTER TABLE "provider_configs" DROP CONSTRAINT "provider_configs_name_check";--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_kind_check" CHECK ("provider_configs"."kind" in ('anthropic', 'openai', 'google', 'deepseek', 'moonshot', 'qwencloud', 'xiaomi-mimo', 'zai', 'openai-compatible'));--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_name_check" CHECK (case when "provider_configs"."kind" = 'openai-compatible'
        then "provider_configs"."name" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'
          and "provider_configs"."name" not in ('anthropic', 'openai', 'google', 'deepseek', 'moonshot', 'qwencloud', 'xiaomi-mimo', 'zai')
          and "provider_configs"."base_url" is not null
        else "provider_configs"."name" = "provider_configs"."kind" and "provider_configs"."api_key" is not null end);