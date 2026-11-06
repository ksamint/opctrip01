/**
 * Cloudflare Workers API Server
 *
 * This is a Hono-based server that handles:
 * - tRPC API requests
 * - OAuth callback
 * - Static file serving (via Cloudflare Pages)
 *
 * Deploy with: npx wrangler pages deploy dist
 */

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { SignJWT, jwtVerify } from "jose";
import { drizzle } from "drizzle-orm/d1";
import {
  cfUsers,
  cfTrips,
  cfTripTranslations,
  cfDays,
  cfDayTranslations,
  cfActivities,
  cfActivityTranslations,
  type CfUser,
} from "../drizzle/cf-schema";
import { eq, and, asc } from "drizzle-orm";

// =============================================================================
// ENV & TYPES
// =============================================================================

type Env = {
  DB: D1Database;
  SESSION_KV: KVNamespace;
  JWT_SECRET: string;
  OAUTH_SERVER_URL: string;
  VITE_APP_ID: string;
  OWNER_OPEN_ID: string;
  BUILT_IN_FORGE_API_URL: string;
  BUILT_IN_FORGE_API_KEY: string;
  NODE_ENV: string;
};

type TrpcContext = {
  user: CfUser | null;
  env: Env;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const COOKIE_NAME = "app_session_id";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

// =============================================================================
// TRPC INIT
// =============================================================================

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Please login (10001)" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(requireUser);

const requireAdmin = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user || ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have required permission (10002)",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = t.procedure.use(requireAdmin);

// =============================================================================
// SESSION MANAGEMENT (JWT via jose)
// =============================================================================

const getSessionSecret = (env: Env) =>
  new TextEncoder().encode(env.JWT_SECRET || "default-secret-change-me");

const verifySession = async (
  env: Env,
  cookieValue: string | undefined
): Promise<{ openId: string; appId: string; name: string } | null> => {
  if (!cookieValue) return null;
  try {
    const secretKey = getSessionSecret(env);
    const { payload } = await jwtVerify(cookieValue, secretKey, {
      algorithms: ["HS256"],
    });
    const openId = payload.openId as string;
    const appId = payload.appId as string;
    const name = payload.name as string;
    if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
      return null;
    }
    return { openId, appId, name };
  } catch {
    return null;
  }
};

const createSessionToken = async (
  env: Env,
  openId: string,
  name: string
): Promise<string> => {
  const secretKey = getSessionSecret(env);
  const expirationSeconds = Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS;

  return new SignJWT({ openId, appId: env.VITE_APP_ID, name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(secretKey);
};

// =============================================================================
// DATABASE HELPERS (D1)
// =============================================================================

const getDb = (env: Env) => drizzle(env.DB);

const getUserByOpenId = async (env: Env, openId: string): Promise<CfUser | null> => {
  const db = getDb(env);
  const result = await db
    .select()
    .from(cfUsers)
    .where(eq(cfUsers.openId, openId))
    .limit(1);
  return result[0] ?? null;
};

const upsertUser = async (
  env: Env,
  userData: {
    openId: string;
    name?: string | null;
    email?: string | null;
    loginMethod?: string | null;
    lastSignedIn?: Date;
    role?: "user" | "admin";
  }
) => {
  const db = getDb(env);
  const existing = await getUserByOpenId(env, userData.openId);
  const now = new Date();

  if (existing) {
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (userData.name !== undefined) updateData.name = userData.name;
    if (userData.email !== undefined) updateData.email = userData.email;
    if (userData.loginMethod !== undefined)
      updateData.loginMethod = userData.loginMethod;
    if (userData.lastSignedIn !== undefined)
      updateData.lastSignedIn = userData.lastSignedIn;
    if (userData.role !== undefined) updateData.role = userData.role;

    await db
      .update(cfUsers)
      .set(updateData)
      .where(eq(cfUsers.openId, userData.openId));
  } else {
    const isOwner = userData.openId === env.OWNER_OPEN_ID;
    await db.insert(cfUsers).values({
      openId: userData.openId,
      name: userData.name ?? null,
      email: userData.email ?? null,
      loginMethod: userData.loginMethod ?? null,
      role: userData.role ?? (isOwner ? "admin" : "user"),
      lastSignedIn: userData.lastSignedIn ?? now,
      createdAt: now,
      updatedAt: now,
    });
  }
};

// =============================================================================
// ZOD SCHEMA HELPER (inline to avoid import issues in Workers)
// =============================================================================

const z = {
  object: (schema: Record<string, any>) => ({
    _input: schema,
    parse: (input: any) => {
      const result: Record<string, any> = {};
      for (const [key, def] of Object.entries(schema)) {
        const val = input?.[key];
        if (def.optional && val === undefined) {
          result[key] = def.default ? def.default() : undefined;
        } else if (def.enum) {
          if (!def.enum.includes(val)) {
            throw new Error(`Invalid value for ${key}`);
          }
          result[key] = val;
        } else if (def.default && val === undefined) {
          result[key] = def.default;
        } else if (def.minLength !== undefined && (typeof val !== "string" || val.length < def.minLength)) {
          throw new Error(`${key} is required`);
        } else {
          result[key] = val;
        }
      }
      return result;
    },
  }),
  string: () => ({ _type: "string" }),
  number: () => ({ _type: "number" }),
  enum: (values: string[]) => ({ _type: "enum", enum: values }),
};

// =============================================================================
// TRPC ROUTER
// =============================================================================

const appRouter = router({
  // ==================== AUTH ====================
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),

    logout: publicProcedure.mutation((opts) => {
      // Cookie clearing is handled client-side
      return { success: true } as const;
    }),
  }),

  // ==================== TRIPS ====================
  trips: router({
    list: publicProcedure
      .input(() => ({ lang: "zh" as const }))
      .query(async ({ ctx, input }) => {
        const db = getDb(ctx.env);
        const lang = input.lang ?? "zh";

        const result = await db
          .select({
            id: cfTrips.id,
            slug: cfTrips.slug,
            heroImage: cfTrips.heroImage,
            accentColor: cfTrips.accentColor,
            dates: cfTrips.dates,
            sortOrder: cfTrips.sortOrder,
            isPublished: cfTrips.isPublished,
            title: cfTripTranslations.title,
            subtitle: cfTripTranslations.subtitle,
            location: cfTripTranslations.location,
            description: cfTripTranslations.description,
          })
          .from(cfTrips)
          .leftJoin(
            cfTripTranslations,
            and(
              eq(cfTrips.id, cfTripTranslations.tripId),
              eq(cfTripTranslations.lang, lang)
            )
          )
          .where(eq(cfTrips.isPublished, 1))
          .orderBy(asc(cfTrips.sortOrder));

        return result;
      }),

    getBySlug: publicProcedure
      .input(() => ({ slug: "", lang: "zh" as const }))
      .query(async ({ ctx, input }) => {
        const db = getDb(ctx.env);
        const lang = input.lang ?? "zh";

        const tripResult = await db
          .select({
            id: cfTrips.id,
            slug: cfTrips.slug,
            heroImage: cfTrips.heroImage,
            accentColor: cfTrips.accentColor,
            dates: cfTrips.dates,
            sortOrder: cfTrips.sortOrder,
            isPublished: cfTrips.isPublished,
            title: cfTripTranslations.title,
            subtitle: cfTripTranslations.subtitle,
            location: cfTripTranslations.location,
            description: cfTripTranslations.description,
          })
          .from(cfTrips)
          .leftJoin(
            cfTripTranslations,
            and(
              eq(cfTrips.id, cfTripTranslations.tripId),
              eq(cfTripTranslations.lang, lang)
            )
          )
          .where(eq(cfTrips.slug, input.slug))
          .limit(1);

        const trip = tripResult[0];
        if (!trip) return null;

        const daysResult = await db
          .select({
            id: cfDays.id,
            tripId: cfDays.tripId,
            dayNumber: cfDays.dayNumber,
            image: cfDays.image,
            sortOrder: cfDays.sortOrder,
            title: cfDayTranslations.title,
            date: cfDayTranslations.date,
            description: cfDayTranslations.description,
          })
          .from(cfDays)
          .leftJoin(
            cfDayTranslations,
            and(eq(cfDays.id, cfDayTranslations.dayId), eq(cfDayTranslations.lang, lang))
          )
          .where(eq(cfDays.tripId, trip.id))
          .orderBy(asc(cfDays.sortOrder));

        const daysWithActivities = await Promise.all(
          daysResult.map(async (day) => {
            const activitiesResult = await db
              .select({
                id: cfActivities.id,
                dayId: cfActivities.dayId,
                time: cfActivities.time,
                sortOrder: cfActivities.sortOrder,
                title: cfActivityTranslations.title,
                description: cfActivityTranslations.description,
              })
              .from(cfActivities)
              .leftJoin(
                cfActivityTranslations,
                and(
                  eq(cfActivities.id, cfActivityTranslations.activityId),
                  eq(cfActivityTranslations.lang, lang)
                )
              )
              .where(eq(cfActivities.dayId, day.id))
              .orderBy(asc(cfActivities.sortOrder));

            return { ...day, activities: activitiesResult };
          })
        );

        return { ...trip, days: daysWithActivities };
      }),
  }),

  // ==================== SYSTEM ====================
  system: router({
    health: publicProcedure.query(() => ({ ok: true })),
  }),
});

export type AppRouter = typeof appRouter;

// =============================================================================
// AUTHENTICATE REQUEST
// =============================================================================

const authenticateRequest = async (
  env: Env,
  request: Request
): Promise<CfUser | null> => {
  const cookieHeader = request.headers.get("cookie");
  let sessionCookie: string | undefined;

  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c) => {
        const [k, ...v] = c.trim().split("=");
        return [k, v.join("=")];
      })
    );
    sessionCookie = cookies[COOKIE_NAME];
  }

  const session = await verifySession(env, sessionCookie);
  if (!session) return null;

  const user = await getUserByOpenId(env, session.openId);
  if (!user) return null;

  // Update lastSignedIn
  await upsertUser(env, {
    openId: user.openId,
    lastSignedIn: new Date(),
  });

  return user;
};

// =============================================================================
// OAUTH CALLBACK HANDLER
// =============================================================================

const EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
const GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;

const handleOAuthCallback = async (env: Env, url: URL): Promise<Response> => {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response(JSON.stringify({ error: "code and state required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const redirectUri = atob(state);

    // Exchange code for token
    const tokenRes = await fetch(`${env.OAUTH_SERVER_URL}${EXCHANGE_TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: env.VITE_APP_ID,
        grantType: "authorization_code",
        code,
        redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }

    const tokenData = (await tokenRes.json()) as { accessToken: string };

    // Get user info
    const userInfoRes = await fetch(
      `${env.OAUTH_SERVER_URL}${GET_USER_INFO_PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: tokenData.accessToken }),
      }
    );

    if (!userInfoRes.ok) {
      throw new Error(`Get user info failed: ${userInfoRes.status}`);
    }

    const userInfo = (await userInfoRes.json()) as {
      openId: string;
      name?: string;
      email?: string;
      platform?: string;
      loginMethod?: string;
    };

    if (!userInfo.openId) {
      return new Response(JSON.stringify({ error: "openId missing" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Upsert user
    await upsertUser(env, {
      openId: userInfo.openId,
      name: userInfo.name || null,
      email: userInfo.email ?? null,
      loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
      lastSignedIn: new Date(),
    });

    // Create session token
    const sessionToken = await createSessionToken(
      env,
      userInfo.openId,
      userInfo.name || ""
    );

    // Redirect to home with cookie set
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ONE_YEAR_SECONDS}`,
      },
    });
  } catch (error) {
    console.error("[OAuth] Callback failed:", error);
    return new Response(JSON.stringify({ error: "OAuth callback failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

// =============================================================================
// CORS HEADERS
// =============================================================================

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, cookie",
  "Access-Control-Allow-Credentials": "true",
});

// =============================================================================
// MAIN HANDLER (Hono App)
// =============================================================================

const app = new Hono<{
  Bindings: Env;
  Variables: { user: CfUser | null; env: Env };
}>();

// CORS preflight
app.options("*", (c) => {
  const origin = c.req.header("Origin") ?? null;
  return new Response(null, {
    headers: {
      ...getCorsHeaders(origin),
      "Access-Control-Max-Age": "86400",
    },
  });
});

// Auth middleware - runs before tRPC
app.use("/api/trpc/*", async (c, next) => {
  const user = await authenticateRequest(c.env, c.req.raw);
  c.set("user", user);
  c.set("env", c.env);
  await next();
});

// OAuth callback
app.get("/api/oauth/callback", async (c) => {
  return handleOAuthCallback(c.env, new URL(c.req.url));
});

// tRPC handler
app.all("/api/trpc/:path", async (c) => {
  const user = c.get("user") ?? null;

  // superjson is configured on the router (initTRPC.create above).
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => ({ user, env: c.env as Env }),
  });
});

// Health check
app.get("/api/health", (c) => c.json({ ok: true }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // @ts-ignore
    return app.fetch(request, env, ctx);
  },
};
