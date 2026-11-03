CREATE TABLE "issue_priorities" (
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"priority" text NOT NULL,
	"reason" text NOT NULL,
	"model" text NOT NULL,
	"rated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_priorities_project_id_issue_id_pk" PRIMARY KEY("project_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "issue_priorities" ADD CONSTRAINT "issue_priorities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;