ALTER TABLE "principals" DROP CONSTRAINT "principals_status_check";--> statement-breakpoint
ALTER TABLE "principals" DROP CONSTRAINT "principals_user_has_email_check";--> statement-breakpoint
ALTER TABLE "tool_invocations" ALTER COLUMN "arguments" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "principals" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "principals" ADD COLUMN "deleted_by_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_deleted_check" CHECK (("principals"."status" = 'deleted') = ("principals"."deleted_at" is not null)
        and ("principals"."deleted_at" is null) = ("principals"."deleted_by_principal_id" is null));--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_status_check" CHECK ("principals"."status" in ('active', 'suspended', 'deleted'));--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_user_has_email_check" CHECK (case when "principals"."kind" = 'user' then "principals"."email" is not null or "principals"."status" = 'deleted'
        else "principals"."email" is null end);