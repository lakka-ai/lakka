CREATE TABLE "spans" (
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"workspace_id" uuid,
	"request_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"error_type" text,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" double precision NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "spans_pkey" PRIMARY KEY("trace_id","span_id","started_at"),
	CONSTRAINT "spans_kind_check" CHECK ("spans"."kind" in ('internal', 'server', 'client', 'producer', 'consumer')),
	CONSTRAINT "spans_status_check" CHECK ("spans"."status" in ('unset', 'ok', 'error')),
	CONSTRAINT "spans_duration_check" CHECK ("spans"."duration_ms" >= 0)
) PARTITION BY RANGE ("started_at");
--> statement-breakpoint
CREATE INDEX "spans_workspace_started_idx" ON "spans" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "spans_request_idx" ON "spans" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "spans_trace_idx" ON "spans" USING btree ("trace_id");