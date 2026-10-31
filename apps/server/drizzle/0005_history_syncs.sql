CREATE TABLE "history_syncs" (
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"harness" text NOT NULL,
	"total" integer NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "history_syncs_project_id_id_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "device_links" ADD COLUMN "history_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "history_syncs" ADD CONSTRAINT "history_syncs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "history_syncs_project_updated" ON "history_syncs" USING btree ("project_id","updated_at");