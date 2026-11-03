CREATE TABLE "run_findings" (
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"subject" text NOT NULL,
	"evidence" text NOT NULL,
	"verdict" text,
	"step_id" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_findings_project_id_run_id_kind_pk" PRIMARY KEY("project_id","run_id","kind")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_findings" ADD CONSTRAINT "run_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_findings" ADD CONSTRAINT "run_findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_findings_project_status" ON "run_findings" USING btree ("project_id","status");