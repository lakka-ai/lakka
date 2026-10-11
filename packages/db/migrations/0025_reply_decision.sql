ALTER TABLE "messages" ADD COLUMN "routing_confidence" real;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "routing_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "fallback_scope" text;--> statement-breakpoint
CREATE INDEX "tool_invocations_conversation_idx" ON "tool_invocations" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_routing_confidence_check" CHECK ("messages"."routing_confidence" is null or "messages"."routing_confidence" between 0 and 1);