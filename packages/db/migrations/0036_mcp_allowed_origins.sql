CREATE TABLE "mcp_allowed_origins" (
	"origin" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_allowed_origins_origin_check" CHECK ("mcp_allowed_origins"."origin" ~ '^https?://[^/]+$'),
	CONSTRAINT "mcp_allowed_origins_source_check" CHECK ("mcp_allowed_origins"."source" in ('admin', 'upgrade'))
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "egress_grandfathered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_allowed_origins" ADD CONSTRAINT "mcp_allowed_origins_added_by_principals_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The servers that exist keep working (NF-S4, ADR 0117): their origins are listed, as core's
-- normaliseOrigin writes them (lowercase, no default port). A URL this cannot read, such as one
-- with a non-ASCII host, is left out; its server then waits for an instance admin to list it.
INSERT INTO "mcp_allowed_origins" ("origin", "source")
SELECT DISTINCT o.origin, 'upgrade'
FROM (
  SELECT regexp_replace(
    regexp_replace(lower(substring("url" from '^[A-Za-z]+://[^/?#]+')), '^(https://.+):443$', '\1'),
    '^(http://.+):80$', '\1'
  ) AS origin
  FROM "mcp_servers"
  WHERE "transport" = 'streamable_http'
) o
WHERE o.origin ~ '^https?://[^/@]+$' AND o.origin ~ '^[\x21-\x7e]+$'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Origins their OAuth metadata names are listed the first time each server discovers them.
UPDATE "mcp_servers" SET "egress_grandfathered" = true WHERE "transport" = 'streamable_http';
