CREATE TABLE "issue_groups" (
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"group_id" text,
	"split" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_groups_project_id_issue_id_pk" PRIMARY KEY("project_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "issue_groups" ADD CONSTRAINT "issue_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;