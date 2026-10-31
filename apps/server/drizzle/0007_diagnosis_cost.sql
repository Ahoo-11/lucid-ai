ALTER TABLE "issue_explanations" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "issue_explanations" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "issue_explanations" ADD COLUMN "latency_ms" integer;