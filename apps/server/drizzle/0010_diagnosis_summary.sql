ALTER TABLE "issue_explanations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "issue_explanations" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;