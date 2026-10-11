CREATE TABLE "span_content" (
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"prompt" jsonb NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "span_content_pkey" PRIMARY KEY("trace_id","span_id"),
	CONSTRAINT "span_content_expiry_check" CHECK ("span_content"."expires_at" > "span_content"."created_at")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "content_capture" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "content_retention_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "content_capture_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "content_capture_changed_by" uuid;--> statement-breakpoint
CREATE INDEX "span_content_workspace_created_idx" ON "span_content" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "span_content_request_idx" ON "span_content" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "span_content_expires_idx" ON "span_content" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_content_retention_check" CHECK ("workspaces"."content_retention_days" between 1 and 90);