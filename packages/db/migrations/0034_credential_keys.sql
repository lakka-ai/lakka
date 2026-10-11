CREATE TABLE "credential_keys" (
	"version" integer PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "credential_keys_version_check" CHECK ("credential_keys"."version" >= 1)
);
