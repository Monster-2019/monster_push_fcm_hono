import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { validator } from "hono/validator";
import { z } from "zod";
import {
  getAccessToken,
  parseSignature,
  sendJson,
  timingSafeEqual,
  toHex,
} from "./lib";

type Bindings = {
  FIREBASE_ADMINSDK: string;
  FCM: KVNamespace;
  HMAC_SECRET: string;
};

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
      title: z.string().min(1, "标题不能为空"),
      body: z.string().min(1, "内容不能为空"),
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
    .array(z.string().min(1, "Token 不能为空"))
    .min(1, "至少需要提供一个 Token"),
});

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
  if (!timingSafeEqual(signatureHex, expectedHex)) {
    return sendJson(c, 401, "Invalid signature", null);
  }

  await next();
};

// app.get("/", async (c) => {
//   try {
//     const data = await getAccessToken(c.env);
//     return c.text(data);
//   } catch (e) {
//     return c.text(String(e));
//   }
// });

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

app.post(
  "/send",
  verifyHmacSignature,
  validator("json", (value, c) => {
    if (!value || Object.keys(value).length === 0) {
      return sendJson(c, 400, "Payload is empty", null);
    }
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) {
      return sendJson(c, 400, "Invalid request body", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    return parsed.data;
  }),
  async (c) => {
    const data = c.req.valid("json");
    const accessToken = await getAccessToken(c.env);
    if (!accessToken) return sendJson(c, 500, "Invalid AccessToken", null);

    const { tokens, message } = data;
    if (!tokens.length) return sendJson(c, 200, "No tokens to send", []);
    try {
      const pendingList = Promise.all(
        tokens.map(async (token: string) => {
          const res = await fetch(SEND_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + accessToken,
            },
            body: JSON.stringify({
              message: {
                ...message,
                token,
              },
            }),
          });
          return await res.json().catch((e) => JSON.stringify(e));
        }),
      );
      const result = await pendingList;
      return sendJson(c, 200, "ok", result);
    } catch (e) {
      return sendJson(c, 500, "Failed to send push messages", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
);

export default app;
