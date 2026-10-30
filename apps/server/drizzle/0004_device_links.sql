CREATE TABLE "device_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"machine" text NOT NULL,
	"os" text,
	"agents" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"project_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_links_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "device_links_device_code_hash_unique" UNIQUE("device_code_hash")
);
--> statement-breakpoint
ALTER TABLE "device_links" ADD CONSTRAINT "device_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;