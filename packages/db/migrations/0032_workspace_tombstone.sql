ALTER TABLE "workspaces" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deleted_by_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspaces_unpurged_idx" ON "workspaces" USING btree ("deleted_at") WHERE "workspaces"."deleted_at" is not null and "workspaces"."purged_at" is null;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_deleted_check" CHECK (("workspaces"."deleted_at" is null) = ("workspaces"."deleted_by_principal_id" is null)
        and ("workspaces"."purged_at" is null or "workspaces"."deleted_at" is not null));