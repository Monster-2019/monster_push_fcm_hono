import { Hono } from "hono";

type Bindings = {
  FIREBASE_ADMINSDK: string;
  FCM: KVNamespace;
};

interface GoogleAuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

const app = new Hono<{ Bindings: Bindings }>();

const SEND_URL =
  "https://fcm.googleapis.com/v1/projects/monster-push/messages:send";

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
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedJWT)
  );

  const signedJWT =
    unsignedJWT +
    "." +
    btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  // 5️⃣ 请求 Google token
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
};

const getAccessToken = async (env: Bindings) => {
  let accessToken: string | null = await env.FCM.get("accessToken");
  if (!accessToken) {
    accessToken = await fetchAccessToken(env.FIREBASE_ADMINSDK);
    await env.FCM.put("accessToken", accessToken, { expirationTtl: 3600 });
  }
  return accessToken;
};

app.get("/", async (c) => {
  try {
    const data = await getAccessToken(c.env);
    return c.text(data);
  } catch (e) {
    return c.text(String(e));
  }
});

app.post("/send", async (c) => {
  const req = await c.req.json();

  const accessToken = await getAccessToken(c.env);

  const { tokens, message } = req;
  if (!tokens.length) return c.json([]);
  try {
    const pendingList = Promise.all(
      tokens.map(
        async (token: string) =>
          await fetch(SEND_URL, {
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
          })
      )
    );
    const result = await pendingList;
    return c.json(result);
  } catch (e) {
    return c.text(JSON.stringify(e));
  }
});

export default app;
