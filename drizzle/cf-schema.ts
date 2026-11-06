import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import {
  int,
  text,
  sqliteTable,
  integer,
} from "drizzle-orm/sqlite-core";

/**
 * Core user table backing auth flow.
 * Cloudflare D1 / SQLite compatible schema.
 */
export const cfUsers = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  openId: text("openId").notNull().unique(),
  name: text("name"),
  email: text("email"),
  loginMethod: text("loginMethod"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  lastSignedIn: integer("lastSignedIn", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type CfUser = typeof cfUsers.$inferSelect;
export type InsertCfUser = typeof cfUsers.$inferInsert;

/**
 * Trips table - stores trip metadata
 */
export const cfTrips = sqliteTable("trips", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  heroImage: text("heroImage").notNull(),
  accentColor: text("accentColor").notNull().default("#F59E0B"),
  dates: text("dates").notNull(),
  sortOrder: integer("sortOrder").notNull().default(0),
  isPublished: integer("isPublished").notNull().default(1),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type CfTrip = typeof cfTrips.$inferSelect;
export type InsertCfTrip = typeof cfTrips.$inferInsert;

/**
 * Trip translations - bilingual content for trips
 */
export const cfTripTranslations = sqliteTable("trip_translations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tripId: integer("tripId").notNull(),
  lang: text("lang", { enum: ["zh", "en"] }).notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  location: text("location").notNull(),
  description: text("description"),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type CfTripTranslation = typeof cfTripTranslations.$inferSelect;
export type InsertCfTripTranslation = typeof cfTripTranslations.$inferInsert;

/**
 * Days table - stores day-by-day itinerary
 */
export const cfDays = sqliteTable("days", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tripId: integer("tripId").notNull(),
  dayNumber: integer("dayNumber").notNull(),
  image: text("image"),
  sortOrder: integer("sortOrder").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type CfDay = typeof cfDays.$inferSelect;
export type InsertCfDay = typeof cfDays.$inferInsert;

/**
 * Day translations - bilingual content for days
 */
export const cfDayTranslations = sqliteTable("day_translations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayId: integer("dayId").notNull(),
  lang: text("lang", { enum: ["zh", "en"] }).notNull(),
  title: text("title").notNull(),
  date: text("date"),
  description: text("description"),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type CfDayTranslation = typeof cfDayTranslations.$inferSelect;
export type InsertCfDayTranslation = typeof cfDayTranslations.$inferInsert;

/**
 * Activities table - stores activities within each day
 */
export const cfActivities = sqliteTable("activities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayId: integer("dayId").notNull(),
  time: text("time"),
  sortOrder: integer("sortOrder").notNull().default(0),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type CfActivity = typeof cfActivities.$inferSelect;
export type InsertCfActivity = typeof cfActivities.$inferInsert;

/**
 * Activity translations - bilingual content for activities
 */
export const cfActivityTranslations = sqliteTable("activity_translations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  activityId: integer("activityId").notNull(),
  lang: text("lang", { enum: ["zh", "en"] }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  createdAt: integer("createdAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type CfActivityTranslation = typeof cfActivityTranslations.$inferSelect;
export type InsertCfActivityTranslation = typeof cfActivityTranslations.$inferInsert;
