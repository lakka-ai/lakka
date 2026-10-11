CREATE TABLE "sso_provider_policies" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"allow_sign_up" boolean DEFAULT false NOT NULL,
	"allowed_email_domains" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain" text NOT NULL,
	CONSTRAINT "sso_providers_provider_id_key" UNIQUE("provider_id")
);
--> statement-breakpoint
ALTER TABLE "sso_provider_policies" ADD CONSTRAINT "sso_provider_policies_provider_id_sso_providers_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("provider_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;