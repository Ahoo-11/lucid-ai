CREATE TABLE "fix_tests" (
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"lesson" text NOT NULL,
	"revised_from" text,
	"status" text NOT NULL,
	"results" jsonb,
	"model" text,
	"stand_in" text,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "fix_tests_project_id_issue_id_pk" PRIMARY KEY("project_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "fix_tests" ADD CONSTRAINT "fix_tests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;