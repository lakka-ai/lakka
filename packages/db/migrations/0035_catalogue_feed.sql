CREATE TABLE "catalogue_feed" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_by" uuid,
	"enabled_at" timestamp with time zone,
	"envelope" text,
	"applied_serial" integer,
	"applied_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_result" text,
	"last_error_code" text,
	"check_requested_at" timestamp with time zone,
	"check_minute" integer DEFAULT floor(random() * 1440) NOT NULL,
	CONSTRAINT "catalogue_feed_singleton_check" CHECK ("catalogue_feed"."id"),
	CONSTRAINT "catalogue_feed_minute_check" CHECK ("catalogue_feed"."check_minute" between 0 and 1439),
	CONSTRAINT "catalogue_feed_result_check" CHECK ("catalogue_feed"."last_result" is null or "catalogue_feed"."last_result" in ('applied', 'unchanged', 'failed')),
	CONSTRAINT "catalogue_feed_applied_check" CHECK (("catalogue_feed"."envelope" is null) = ("catalogue_feed"."applied_serial" is null))
);

--> statement-breakpoint
-- The one row: price updates start off, at a random minute of the day (NF-P2, ADR 0116).
INSERT INTO "catalogue_feed" ("id") VALUES (true);
