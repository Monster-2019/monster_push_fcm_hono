import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { serve } from "@upstash/workflow/hono";
import { getAccessToken, sendJson, timingSafeEqual, toHex } from "./lib";
import { getFetchOptions } from "./lib/fetch";

type Env = {
  Bindings: Bindings; // 你的环境变量类型
  Variables: {
    validatedPayload: SendRequestPayload; // 你的自定义上下文变量
  };
};

const app = new Hono<Env>();

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
  scheduledAt: z.string().optional(),
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

  // 假设 parseSignature 获取 hex，这里直接简单对比（若格式不符由 timingSafeEqual 兜底或长度前置判断）
  if (signatureHeader.length !== HEX_SIGNATURE_LENGTH) {
    return sendJson(c, 401, "Invalid signature format", null);
  }

  if (!timingSafeEqual(signatureHeader, expectedHex)) {
    return sendJson(c, 401, "Invalid signature", null);
  }

  await next();
};

const validateSendPayload: MiddlewareHandler<Env> = async (c, next) => {
  let payload: unknown;
  try {
    payload = await c.req.raw.json();
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

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return sendJson(c, 400, "Invalid request body", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  c.set("validatedPayload", parsed.data);
  await next();
};

const sendPushMessages = async (
  payload: SendRequestPayload,
  headers: Record<string, string | null>,
  env: Bindings,
) => {
  console.log("send");
  const { tokens, message } = payload;
  if (!tokens.length) return [];

  const accessToken = await getAccessToken(env);
  if (!accessToken) throw new Error("Invalid AccessToken");

  return await Promise.all(
    tokens.map(async (token) => {
      const response = await fetch(
        SEND_URL,
        getFetchOptions({ ...message, token }, headers, accessToken),
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
  const { scheduledAt } = payload;

  const headers = {
    "x-signature": context.headers.get("x-signature") ?? "",
    "x-timestamp": context.headers.get("x-timestamp") ?? "",
  };

  if (scheduledAt) {
    console.log(scheduledAt);
    await context.sleepUntil("wait-for-push", scheduledAt);
  }

  await context.run("execute-push", async () => {
    return await sendPushMessages(
      payload,
      headers,
      context.env as unknown as Bindings,
    );
  });
});

app.post("/send", verifyHmacSignature, validateSendPayload, async (c) => {
  const payload = c.get("validatedPayload");

  await fetch(`${new URL(c.req.url).origin}/workflow/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": c.req.header("x-signature") ?? "",
      "x-timestamp": c.req.header("x-timestamp") ?? "",
    },
    body: JSON.stringify(payload),
  });

  return c.json({ ok: true });
});

app.post("/workflow/send", pushWorkflow);

export default app;
