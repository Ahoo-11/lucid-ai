CREATE TABLE "experiment_items" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"step_id" text NOT NULL,
	"run_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"context" jsonb,
	"seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiment_trials" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"item_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"output" jsonb,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "experiment_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"alias" integer NOT NULL,
	"kind" text NOT NULL,
	"model" text,
	"prompt_mode" text,
	"system_prompt" text,
	"temperature" double precision
);
--> statement-breakpoint
CREATE TABLE "experiment_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"item_id" text NOT NULL,
	"trial_a" text NOT NULL,
	"trial_b" text NOT NULL,
	"winner" text NOT NULL,
	"judge" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"judge_model" text,
	"rubric" text,
	"revealed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "experiment_items" ADD CONSTRAINT "experiment_items_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_trials" ADD CONSTRAINT "experiment_trials_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_trials" ADD CONSTRAINT "experiment_trials_item_id_experiment_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."experiment_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_trials" ADD CONSTRAINT "experiment_trials_variant_id_experiment_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."experiment_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_variants" ADD CONSTRAINT "experiment_variants_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_votes" ADD CONSTRAINT "experiment_votes_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_votes" ADD CONSTRAINT "experiment_votes_item_id_experiment_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."experiment_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trials_item_variant" ON "experiment_trials" USING btree ("item_id","variant_id");--> statement-breakpoint
CREATE INDEX "votes_experiment" ON "experiment_votes" USING btree ("experiment_id","judge");--> statement-breakpoint
CREATE INDEX "experiments_project" ON "experiments" USING btree ("project_id","created_at");