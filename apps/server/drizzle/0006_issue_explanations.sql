CREATE TABLE "issue_explanations" (
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"why" text,
	"fix" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_explanations_project_id_issue_id_pk" PRIMARY KEY("project_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "issue_explanations" ADD CONSTRAINT "issue_explanations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;