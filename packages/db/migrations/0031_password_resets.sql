CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" uuid NOT NULL,
	"principal_kind" text GENERATED ALWAYS AS ('user') STORED,
	"token_hash" text NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_by_kind" text GENERATED ALWAYS AS ('user') STORED,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "password_resets_principal_id_key" UNIQUE("principal_id"),
	CONSTRAINT "password_resets_token_hash_check" CHECK ("password_resets"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_principal_is_user_fkey" FOREIGN KEY ("principal_id","principal_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_created_by_is_user_fkey" FOREIGN KEY ("created_by_principal_id","created_by_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;