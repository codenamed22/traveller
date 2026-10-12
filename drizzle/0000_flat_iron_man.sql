CREATE TABLE "operations" (
	"id" uuid NOT NULL,
	"owner" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_owner_id_pk" PRIMARY KEY("owner","id")
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"data" jsonb NOT NULL,
	"plan" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"owner" text NOT NULL,
	"day" text NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_owner_day_pk" PRIMARY KEY("owner","day")
);
