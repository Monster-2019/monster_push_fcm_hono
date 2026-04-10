import { Hono, type Context, type MiddlewareHandler } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { cors } from "hono/cors";

type Bindings = {
  FIREBASE_ADMINSDK: string;
  FCM: KVNamespace;
  HMAC_SECRET: string;
};

interface GoogleAuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

type AppContext = Context<{ Bindings: Bindings }>;

const app = new Hono<{ Bindings: Bindings }>();

const SEND_URL =
  "https://fcm.googleapis.com/v1/projects/monster-push/messages:send";
const HMAC_SIGNATURE_HEADER = "x-signature";
const HMAC_TIMESTAMP_HEADER = "x-timestamp";
const HMAC_TOLERANCE_SECONDS = 300;
const HEX_SIGNATURE_LENGTH = 64;

const encoder = new TextEncoder();
const sendJson = <T>(
  c: AppContext,
  status: number,
  message: string,
  data: T,
) => c.json({ code: status, message, data }, status);

const toHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

const parseSignature = (signature: string) => {
  if (/^sha256=/i.test(signature)) {
    return signature.slice("sha256=".length).toLowerCase();
  }
  return signature.toLowerCase();
};

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
            link: z.string().url("链接格式不正确").optional(),
          })
          .optional(),
        notification: z
          .object({
            icon: z.string().url("图标链接格式不正确").optional(),
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

  // 1. 严格检查时间戳
  const timestamp = Number(timestampHeader);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(timestamp) || Math.abs(now - timestamp) > HMAC_TOLERANCE_SECONDS) {
    return sendJson(c, 401, "Invalid or expired timestamp", null);
  }

  // 2. 使用 clone().arrayBuffer() 处理，这对处理原始数据更可靠
  // 避免 text() 可能产生的编码/换行符问题
  const bodyBuffer = await c.req.raw.clone().arrayBuffer();
  const rawBody = new TextDecoder().decode(bodyBuffer);

  // 如果你发现后面的 validator 拿到的 value 是 {}
  // 可以在这里强制把解析好的 body 挂载一下，或者确保流没死

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

  // 3. 安全比较 (假设你的 timingSafeEqual 支持 hex 字符串比较)
  if (!timingSafeEqual(signatureHex, expectedHex)) {
    return sendJson(c, 401, "Invalid signature", null);
  }

  await next();
};

const fetchAccessToken = async (FIREBASE_ADMINSDK: string) => {
  const sa = JSON.parse(FIREBASE_ADMINSDK);
  const now = Math.floor(Date.now() / 1000);

  // 1️⃣ 构造 JWT header + payload
  const header = { alg: "RS256", typ: "JWT", kid: sa.private_key_id };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  // 2️⃣ Base64URL 编码
  const base64url = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const unsignedJWT = `${base64url(header)}.${base64url(payload)}`;

  // 3️⃣ 导入私钥
  const pkcs8 = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");
  const keyData = Uint8Array.from(atob(pkcs8), (c) => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedJWT),
  );

  const signedJWT =
    unsignedJWT +
    "." +
    btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  // 5️⃣ 请求 Google token
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signedJWT,
      }),
    });

    const data: GoogleAuthResponse = await res.json();
    return data.access_token;
  } catch (e) {
    return "";
  }
};

const getAccessToken = async (env: Bindings) => {
  let accessToken: string | null = await env.FCM.get("accessToken");
  if (!accessToken) {
    accessToken = await fetchAccessToken(env.FIREBASE_ADMINSDK);
    await env.FCM.put("accessToken", accessToken, { expirationTtl: 3600 });
  }
  return accessToken;
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
          // 这里的 path 处理会将层级连起来，如 "message.notification.title"
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
