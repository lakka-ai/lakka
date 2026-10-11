-- pgvector holds route example and centroid embeddings (ADR 0042). drizzle-kit does not manage
-- extensions, so this line is added by hand. It needs a role allowed to create extensions, which
-- the bundled Postgres has; an external Postgres must have pgvector installed.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "route_centroids" (
	"route_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"embedding" vector NOT NULL,
	"embedding_model" text NOT NULL,
	"example_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_examples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"route_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"text" text NOT NULL,
	"position" integer NOT NULL,
	"embedding" vector,
	"embedding_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_examples_route_text_key" UNIQUE("route_id","text"),
	CONSTRAINT "route_examples_text_check" CHECK (length("route_examples"."text") between 1 and 1000),
	CONSTRAINT "route_examples_embedding_check" CHECK (("route_examples"."embedding" is null) = ("route_examples"."embedding_model" is null))
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"fallbacks" text[] DEFAULT '{}'::text[] NOT NULL,
	"allow_cross_provider" boolean DEFAULT false NOT NULL,
	"threshold_down" double precision NOT NULL,
	"threshold_up" double precision NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"signals" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_by_kind" text GENERATED ALWAYS AS ('user') STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routes_workspace_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "routes_name_check" CHECK ("routes"."name" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
	CONSTRAINT "routes_thresholds_check" CHECK ("routes"."threshold_up" > 0 and "routes"."threshold_down" <= 1 and "routes"."threshold_down" >= "routes"."threshold_up"),
	CONSTRAINT "routes_fallbacks_check" CHECK (cardinality("routes"."fallbacks") <= 5),
	CONSTRAINT "routes_signals_check" CHECK ("routes"."signals" <@ array['code_fence', 'code_file']::text[])
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "routing_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "pinned_model" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "policy_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "route_centroids" ADD CONSTRAINT "route_centroids_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_centroids" ADD CONSTRAINT "route_centroids_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_examples" ADD CONSTRAINT "route_examples_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_examples" ADD CONSTRAINT "route_examples_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_created_by_is_user_fkey" FOREIGN KEY ("created_by_principal_id","created_by_kind") REFERENCES "public"."principals"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_centroids_workspace_id_idx" ON "route_centroids" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "route_examples_workspace_id_idx" ON "route_examples" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "routes_workspace_id_idx" ON "routes" USING btree ("workspace_id");