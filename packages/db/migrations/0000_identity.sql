CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"principal_kind" text GENERATED ALWAYS AS ('key') STORED,
	"workspace_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_principal_id_key" UNIQUE("principal_id"),
	CONSTRAINT "api_keys_hash_key" UNIQUE("hash"),
	CONSTRAINT "api_keys_hash_check" CHECK ("api_keys"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"principal_kind" text GENERATED ALWAYS AS ('user') STORED,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("workspace_id","principal_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"auth_subject" text,
	"owner_principal_id" uuid,
	"owner_kind" text GENERATED ALWAYS AS (case when owner_principal_id is null then null else 'user' end) STORED,
	"is_instance_admin" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_auth_subject_key" UNIQUE("auth_subject"),
	CONSTRAINT "principals_id_kind_key" UNIQUE("id","kind"),
	CONSTRAINT "principals_kind_check" CHECK ("principals"."kind" in ('user', 'key')),
	CONSTRAINT "principals_status_check" CHECK ("principals"."status" in ('active', 'suspended')),
	CONSTRAINT "principals_key_has_owner_check" CHECK (("principals"."kind" = 'key') = ("principals"."owner_principal_id" is not null)),
	CONSTRAINT "principals_user_has_email_check" CHECK (("principals"."kind" = 'user') = ("principals"."email" is not null)),
	CONSTRAINT "principals_key_fields_check" CHECK ("principals"."kind" = 'user' or ("principals"."auth_subject" is null and not "principals"."is_instance_admin"))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"default_model" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_key" UNIQUE("slug"),
	CONSTRAINT "workspaces_slug_check" CHECK ("workspaces"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "workspaces_name_check" CHECK (length(trim("workspaces"."name")) between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_principal_is_key_fkey" FOREIGN KEY ("principal_id","principal_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_principal_is_user_fkey" FOREIGN KEY ("principal_id","principal_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_owner_is_user_fkey" FOREIGN KEY ("owner_principal_id","owner_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "memberships_principal_id_idx" ON "memberships" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_email_lower_key" ON "principals" USING btree (lower("email")) WHERE "principals"."email" is not null;--> statement-breakpoint
CREATE INDEX "principals_owner_principal_id_idx" ON "principals" USING btree ("owner_principal_id");