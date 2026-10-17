CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"trip_id" uuid NOT NULL,
	"city_id" uuid NOT NULL,
	"target" text NOT NULL,
	"stop_id" uuid,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_owner_trip" ON "tickets" USING btree ("owner","trip_id");