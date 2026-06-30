import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { Client } from "@upstash/qstash"; // 确认为纯 qstash 库
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

let qstashClientInstance: Client | null = null;
function getQStashClient(token: string) {
  if (!qstashClientInstance) {
    qstashClientInstance = new Client({ token });
  }
  return qstashClientInstance;
}

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

app.post("/send", verifyHmacSignature, validateSendPayload, async (c) => {
  const payload = c.get("validatedPayload");
  const { scheduledAt } = payload;

  const headers = {
    "x-signature": c.req.header("x-signature") ?? "",
    "x-timestamp": c.req.header("x-timestamp") ?? "",
  };

  // 场景 A：无定时，立即发送（最快路径，直接打给 FCM，不和 Upstash 产生任何交互）
  if (!scheduledAt) {
    try {
      const results = await sendPushMessages(payload, headers, c.env);
      return c.json({ ok: true, source: "immediate", results });
    } catch (error) {
      console.error("Immediate push failed:", error);
      return sendJson(c, 500, "Immediate push failed", {
        error: String(error),
      });
    }
  }

  // 场景 B：包含定时，将其安全投递至 QStash 延时队列
  try {
    const qstash = getQStashClient(c.env.QSTASH_TOKEN);

    // const currentOrigin = new URL(c.req.url).origin;
    const currentOrigin = "https://fcm-api.dxin.cc";
    // const currentOrigin =
    //   "https://onto-install-compilation-argued.trycloudflare.com";

    const targetTime = Math.floor(new Date(scheduledAt).getTime() / 1000);

    const result = await qstash.publish({
      url: `${currentOrigin}/execute-send`,
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "x-custom-secret": c.env.HMAC_SECRET,
      },
      notBefore: targetTime, // ✅ 注意：毫秒时间戳
    });

    console.log(`Task scheduled successfully. MessageID: ${result.messageId}`);
    return c.json({
      ok: true,
      source: "scheduled",
      messageId: result.messageId,
    });
  } catch (error) {
    console.error("Failed to schedule task with QStash:", error);
    return sendJson(c, 500, "Failed to schedule task", {
      error: String(error),
    });
  }
});

app.post("/execute-send", async (c) => {
  const secret = c.req.header("x-custom-secret");
  if (!secret || secret !== c.env.HMAC_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = (await c.req.json()) as SendRequestPayload;

  const headers = {
    "x-signature": c.req.header("x-signature") ?? "",
    "x-timestamp": c.req.header("x-timestamp") ?? "",
  };

  try {
    console.log("QStash alarm triggered, executing push task...");
    const results = await sendPushMessages(payload, headers, c.env);
    return c.json({ ok: true, results });
  } catch (error) {
    console.error("FCM dispatch failed during scheduled execution:", error);
    // 返回 500 状态码极其关键！QStash 收到 500 后会将其识别为失败，并自动触发内置的指数退避重试（Retry）
    return c.json({ error: String(error) }, 500);
  }
});

export default app;
