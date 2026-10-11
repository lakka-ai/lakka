CREATE TABLE "instance_setup" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by_principal_id" uuid NOT NULL,
	CONSTRAINT "instance_setup_single_row_check" CHECK ("instance_setup"."id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_by_kind" text GENERATED ALWAYS AS ('user') STORED,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_principal_id" uuid,
	"accepted_by_kind" text GENERATED ALWAYS AS (case when accepted_by_principal_id is null then null else 'user' end) STORED,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "invites_role_check" CHECK ("invites"."role" in ('admin', 'member')),
	CONSTRAINT "invites_token_hash_check" CHECK ("invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invites_accepted_check" CHECK (("invites"."accepted_at" is null) = ("invites"."accepted_by_principal_id" is null)),
	CONSTRAINT "invites_accepted_or_revoked_check" CHECK ("invites"."accepted_at" is null or "invites"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "instance_setup" ADD CONSTRAINT "instance_setup_completed_by_principal_id_principals_id_fk" FOREIGN KEY ("completed_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_is_user_fkey" FOREIGN KEY ("created_by_principal_id","created_by_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_by_is_user_fkey" FOREIGN KEY ("accepted_by_principal_id","accepted_by_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_workspace_id_idx" ON "invites" USING btree ("workspace_id");