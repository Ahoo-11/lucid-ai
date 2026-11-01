CREATE TABLE "ignored_issues" (
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ignored_issues_project_id_issue_id_pk" PRIMARY KEY("project_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_diagnose" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ignored_issues" ADD CONSTRAINT "ignored_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;