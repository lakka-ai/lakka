CREATE TABLE "parts" ("id" bigint PRIMARY KEY, "widget_id" integer NOT NULL REFERENCES "widgets" ("id"));
--> statement-breakpoint
INSERT INTO "widgets" ("id", "name") VALUES (1, 'seed');
