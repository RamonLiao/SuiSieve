import { Hono } from "hono";
import { cors } from "hono/cors";
import { HttpError } from "./lib/validate.js";
import { configs } from "./routes/configs.js";
import { collaborators } from "./routes/collaborators.js";
import { vaults } from "./routes/vaults.js";

export const app = new Hono();

app.use("*", cors({ origin: process.env.CORS_ORIGIN ?? "*" }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/", configs);
app.route("/", collaborators);
app.route("/", vaults);

app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "route not found" } }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400 | 404);
  }
  console.error("unhandled error:", err);
  return c.json({ error: { code: "INTERNAL", message: "internal server error" } }, 500);
});
