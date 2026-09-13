import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { badRequest, forbidden, unauthorized } from "./errors.js";

export type Method = "get" | "post" | "patch" | "put" | "delete";
export type AuthLevel = "none" | "user" | "admin";
type Schema = z.ZodType | undefined;
type Infer<T> = T extends z.ZodType ? z.output<T> : undefined;

export interface RouteSpec<B extends Schema, Q extends Schema> {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: AuthLevel;
  body?: B;
  query?: Q;
  responses?: Record<number, string>;
}

export type Ctx = Context<AppEnv>;

function formatIssues(err: z.ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Registers Hono routes with Zod validation and remembers them for the OpenAPI document. */
export class ApiRouter {
  readonly specs: RouteSpec<Schema, Schema>[] = [];
  constructor(readonly app: Hono<AppEnv>) {}

  add<B extends Schema = undefined, Q extends Schema = undefined>(
    spec: RouteSpec<B, Q>,
    handler: (c: Ctx, input: { body: Infer<B>; query: Infer<Q> }) => Response | Promise<Response>,
  ) {
    this.specs.push(spec as RouteSpec<Schema, Schema>);
    this.app.on(spec.method.toUpperCase(), spec.path, async (c) => {
      const user = c.get("user");
      if (spec.auth !== "none" && !user) throw unauthorized();
      if (spec.auth === "admin" && user?.role !== "admin") throw forbidden("Admin only");
      let body: unknown = undefined;
      if (spec.body) {
        let json: unknown;
        try {
          json = await c.req.json();
        } catch {
          throw badRequest("Request body must be valid JSON (Content-Type: application/json)");
        }
        const r = spec.body.safeParse(json);
        if (!r.success) throw badRequest("Invalid request body", formatIssues(r.error));
        body = r.data;
      }
      let query: unknown = undefined;
      if (spec.query) {
        const r = spec.query.safeParse(c.req.query());
        if (!r.success) throw badRequest("Invalid query parameters", formatIssues(r.error));
        query = r.data;
      }
      return handler(c, { body: body as Infer<B>, query: query as Infer<Q> });
    });
  }

  openapi(info: { title: string; version: string; description?: string }, serverUrl: string) {
    const toJson = (s: z.ZodType) => {
      try {
        return z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
      } catch {
        return { type: "object" };
      }
    };
    const paths: Record<string, Record<string, unknown>> = {};
    for (const s of this.specs) {
      const p = s.path.replace(/:(\w+)/g, "{$1}");
      const params: unknown[] = [...s.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
      if (s.query) {
        const js = toJson(s.query) as { properties?: Record<string, unknown>; required?: string[] };
        for (const [name, schema] of Object.entries(js.properties ?? {})) {
          params.push({ name, in: "query", required: js.required?.includes(name) ?? false, schema });
        }
      }
      const { $schema: _drop, ...bodySchema } = s.body ? toJson(s.body) : {};
      const responses: Record<string, unknown> = {};
      for (const [code, desc] of Object.entries(s.responses ?? { 200: "OK" })) responses[code] = { description: desc };
      if (s.auth !== "none") {
        responses["401"] = { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
      }
      responses["400"] = { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
      (paths[p] ??= {})[s.method] = {
        summary: s.summary,
        description: s.description,
        tags: s.tags,
        security: s.auth === "none" ? [] : [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: params.length ? params : undefined,
        requestBody: s.body ? { required: true, content: { "application/json": { schema: bodySchema } } } : undefined,
        responses,
      };
    }
    return {
      openapi: "3.1.0",
      info,
      servers: [{ url: serverUrl }],
      paths,
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", description: "API key created on the API keys page (tm_…)" },
          cookieAuth: { type: "apiKey", in: "cookie", name: "tm_session", description: "Browser session; unsafe methods also need X-CSRF-Token" },
        },
        schemas: {
          Error: {
            type: "object",
            properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} } } },
          },
        },
      },
    };
  }
}

/** Parse "since": epoch ms, epoch seconds, ISO date, or a message id. */
export function parseTimestamp(v: string): number | null {
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : d;
}

export function clientIp(c: Ctx): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",").pop()!.trim();
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}
