import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { serve } from "@upstash/workflow/hono";
import {
  getAccessToken,
  parseSignature,
  sendJson,
  timingSafeEqual,
  toHex,
} from "./lib";
import { getFetchOptions } from "./lib/fetch";

const app = new Hono<{ Bindings: Bindings }>();

const SEND_URL =
  "https://fcm.googleapis.com/v1/projects/monster-push/messages:send";
const HMAC_SIGNATURE_HEADER = "x-signature";
const HMAC_TIMESTAMP_HEADER = "x-timestamp";
const HMAC_TOLERANCE_SECONDS = 300;
const HEX_SIGNATURE_LENGTH = 64;

const encoder = new TextEncoder();

const requestSchema = z.object({
  message: z.object({
    notification: z.object({
      title: z.string().min(1, "Title is required"),
      body: z.string().min(1, "Body is required"),
    }),
    webpush: z
      .object({
        fcm_options: z
          .object({
            link: z.string().url("Invalid link URL").optional(),
          })
          .optional(),
        notification: z
          .object({
            icon: z.string().url("Invalid icon URL").optional(),
          })
          .optional(),
      })
      .optional(),
    data: z.record(z.string(), z.string()).optional(),
  }),
  tokens: z
    .array(z.string().min(1, "Token is required"))
    .min(1, "At least one token is required"),
  scheduled_at: z.string().optional(),
});

type SendRequestPayload = z.infer<typeof requestSchema>;

const verifyHmacSignature: MiddlewareHandler<{ Bindings: Bindings }> = async (
  c,
  next,
) => {
  const secret = c.env.HMAC_SECRET;
  if (!secret) return sendJson(c, 500, "HMAC secret is not configured", null);

  const signatureHeader = c.req.header(HMAC_SIGNATURE_HEADER);
  const timestampHeader = c.req.header(HMAC_TIMESTAMP_HEADER);
  if (!signatureHeader || !timestampHeader) {
    return sendJson(c, 401, "Missing signature headers", null);
  }

  const timestamp = Number(timestampHeader);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(timestamp) || Math.abs(now - timestamp) > HMAC_TOLERANCE_SECONDS) {
    return sendJson(c, 401, "Invalid or expired timestamp", null);
  }

  const bodyBuffer = await c.req.raw.clone().arrayBuffer();
  const rawBody = new TextDecoder().decode(bodyBuffer);
  const payload = `${timestampHeader}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  const expectedHex = toHex(expectedBuffer);
  const signatureHex = parseSignature(signatureHeader);
  if (
    signatureHex.length !== HEX_SIGNATURE_LENGTH ||
    !/^[0-9a-f]+$/i.test(signatureHex)
  ) {
    return sendJson(c, 401, "Invalid signature format", null);
  }

  if (!timingSafeEqual(signatureHex, expectedHex)) {
    return sendJson(c, 401, "Invalid signature", null);
  }

  await next();
};

const validateSendPayload: MiddlewareHandler<{ Bindings: Bindings }> = async (
  c,
  next,
) => {
  let payload: unknown;

  try {
    payload = await c.req.raw.clone().json();
  } catch (_error) {
    return sendJson(c, 400, "Invalid request body", {
      issues: [
        {
          path: "",
          message: "Request body must be valid JSON",
        },
      ],
    });
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length === 0
  ) {
    return sendJson(c, 400, "Payload is empty", null);
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return sendJson(c, 400, "Invalid request body", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  await next();
};

const sendPushMessages = async (payload: SendRequestPayload, env: Bindings) => {
  const { tokens, message } = payload;
  if (!tokens.length) return [];

  const accessToken = await getAccessToken(env);
  if (!accessToken) throw new Error("Invalid AccessToken");

  return await Promise.all(
    tokens.map(async (token) => {
      const response = await fetch(
        SEND_URL,
        getFetchOptions({ ...message, token }, accessToken),
      );

      const body = await response
        .json()
        .catch(async () => ({ raw: await response.text().catch(() => "") }));

      return {
        token,
        status: response.status,
        ok: response.ok,
        body,
      };
    }),
  );
};

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      HMAC_SIGNATURE_HEADER,
      HMAC_TIMESTAMP_HEADER,
    ],
  }),
);

const pushWorkflow = serve<SendRequestPayload, Bindings>(async (context) => {
  const payload = context.requestPayload;
  const { scheduled_at } = payload;
  const runtimeEnv = context.env as unknown as Bindings;

  if (scheduled_at) {
    await context.sleepUntil("wait-for-push", scheduled_at);
  }

  const result = await context.run("execute-push", async () => {
    return await sendPushMessages(payload, runtimeEnv);
  });

  return { code: 200, message: "ok", data: result };
});

app.post("/send", verifyHmacSignature, validateSendPayload, pushWorkflow);

export default app;
