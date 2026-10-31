CREATE TABLE "lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"harness" text NOT NULL,
	"issue_id" text,
	"text" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"turned_off_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "issue_explanations" ADD COLUMN "lesson" text;--> statement-breakpoint
ALTER TABLE "issue_explanations" ADD COLUMN "manual" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lessons_project_harness" ON "lessons" USING btree ("project_id","harness");