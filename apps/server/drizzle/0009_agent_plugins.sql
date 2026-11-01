CREATE TABLE "agent_plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key_id" text NOT NULL,
	"harness" text NOT NULL,
	"version" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"update_requested_at" timestamp with time zone,
	"staged_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_plugins" ADD CONSTRAINT "agent_plugins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_plugins_key" ON "agent_plugins" USING btree ("project_id","key_id","harness");