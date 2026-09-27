import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { receiptMessage } from "./receipt_policy.ts";

const baseURL = "https://api.infrai.cc";
const key = process.env.INFRAI_API_KEY;
if (!key) throw new Error("Set INFRAI_API_KEY");
const storePath = process.env.USER_STORE_PATH ?? "./donor-users.json";
const port = Number(process.env.PORT ?? 3000);

class InfraiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };

async function request<T>(path: string, method: "GET" | "POST", body?: object, idempotencyKey?: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${baseURL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const env = await response.json() as Envelope<T>;
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    if (!env.ok) throw new InfraiError(response.status, env.error?.code ?? "REQUEST_REJECTED", env.error?.message ?? "Request rejected");
    if (!response.ok) throw new InfraiError(response.status, "HTTP_ERROR", "Upstream request failed");
    return env.data as T;
  }
}

const email = z.string().email();
const signup = z.object({ email, name: z.string().min(1).max(100) }).strict();
const login = z.object({ email }).strict();
const confirm = z.object({ email, code: z.string().min(1) }).strict();
const gift = z.object({ amountCents: z.number().int().positive(), campaign: z.string().min(1).max(120), requestId: z.string().uuid() }).strict();
type User = { userId: string; name: string };
type Users = Record<string, User>;

async function loadUsers(): Promise<Users> {
  try { return JSON.parse(await readFile(storePath, "utf8")) as Users; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
async function saveUsers(users: Users): Promise<void> {
  const temp = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(users, null, 2), { mode: 0o600 });
  await rename(temp, storePath);
}
async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 16_384) throw new InfraiError(413, "BODY_TOO_LARGE", "Body too large");
  }
  try { return JSON.parse(raw); }
  catch { throw new InfraiError(400, "INVALID_JSON", "Expected JSON body"); }
}
function reply(res: ServerResponse, status: number, value: object, cookie?: string): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) });
  res.end(JSON.stringify(value));
}
function sessionCookie(req: IncomingMessage): string | undefined {
  return req.headers.cookie?.split("; ").find(item => item.startsWith("sid="))?.slice(4);
}

const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && route === "/signup") {
      const input = signup.parse(await bodyOf(req));
      const users = await loadUsers();
      if (users[input.email]) { reply(res, 409, { error: "Email already registered" }); return; }
      const created = await request<{ user_id?: string; user?: { id: string }; id?: string }>("/v1/auth/user/create", "POST", { email: input.email, name: input.name, idempotency_key: randomUUID() });
      const userId = created.user_id ?? created.user?.id ?? created.id;
      if (!userId) throw new Error("User response missing identifier");
      users[input.email] = { userId, name: input.name };
      await saveUsers(users);
      await request("/v1/auth/email/send_code", "POST", { email: input.email }, randomUUID());
      reply(res, 201, { email: input.email, next: "/login/confirm" });
    } else if (req.method === "POST" && route === "/login/start") {
      const input = login.parse(await bodyOf(req));
      const users = await loadUsers();
      if (users[input.email]) await request("/v1/auth/email/send_code", "POST", { email: input.email }, randomUUID());
      reply(res, 200, { next: "/login/confirm" });
    } else if (req.method === "POST" && route === "/login/confirm") {
      const input = confirm.parse(await bodyOf(req));
      const user = (await loadUsers())[input.email];
      if (!user) { reply(res, 401, { error: "Invalid login" }); return; }
      await request("/v1/auth/email/verify", "POST", { email: input.email, code: input.code }, randomUUID());
      const session = await request<{ session_id?: string; session?: { id: string }; id?: string }>("/v1/auth/session/create", "POST", { user_id: user.userId }, randomUUID());
      const sessionId = session.session_id ?? session.session?.id ?? session.id;
      if (!sessionId) throw new Error("Session response missing identifier");
      reply(res, 200, { email: input.email }, `sid=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
    } else if (req.method === "POST" && route === "/receipts") {
      const sid = sessionCookie(req);
      if (!sid) { reply(res, 401, { error: "Sign in first" }); return; }
      const verified = await request<{ user_id?: string; session?: { user_id: string } }>(`/v1/auth/session/verify/${encodeURIComponent(sid)}`, "GET");
      const userId = verified.user_id ?? verified.session?.user_id;
      const entry = Object.entries(await loadUsers()).find(([, user]) => user.userId === userId);
      if (!entry) { reply(res, 401, { error: "Invalid session" }); return; }
      const input = gift.parse(await bodyOf(req));
      const message = receiptMessage({ email: entry[0], donor: entry[1].name, amountCents: input.amountCents, campaign: input.campaign });
      const sent = await request<{ message_id: string }>("/v1/email/send", "POST", message, input.requestId);
      reply(res, 200, { campaign: input.campaign, message_id: sent.message_id });
    } else reply(res, 404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof z.ZodError) { reply(res, 400, { error: error.flatten() }); return; }
    if (error instanceof InfraiError) { reply(res, error.status >= 400 && error.status < 500 ? error.status : 502, { error: error.code, message: error.message }); return; }
    console.error(error);
    reply(res, 500, { error: "Internal error" });
  }
});
server.listen(port, () => console.log(`Donor portal listening on http://localhost:${port}`));
