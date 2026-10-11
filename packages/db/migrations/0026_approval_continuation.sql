ALTER TABLE "tool_approvals" ADD COLUMN "continued_by_request_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD COLUMN "always" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "tool_approvals_continued_idx" ON "tool_approvals" USING btree ("continued_by_request_id");