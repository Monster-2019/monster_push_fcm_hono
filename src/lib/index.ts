import type { Context } from "hono";

interface GoogleAuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

type FirebaseTokenEnv = {
  FIREBASE_ADMINSDK: string;
  FCM: KVNamespace;
};

const encoder = new TextEncoder();

export const sendJson = <T>(
  c: Context,
  status: number,
  message: string,
  data: T,
) => c.json({ code: status, message, data }, status);

export const toHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

export const parseSignature = (signature: string) => {
  if (/^sha256=/i.test(signature)) {
    return signature.slice("sha256=".length).toLowerCase();
  }
  return signature.toLowerCase();
};

const base64url = (obj: object) =>
  btoa(JSON.stringify(obj))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

export const fetchAccessToken = async (firebaseAdminSdk: string) => {
  const sa = JSON.parse(firebaseAdminSdk);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: sa.private_key_id };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsignedJWT = `${base64url(header)}.${base64url(payload)}`;
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
    encoder.encode(unsignedJWT),
  );
  const signedJWT =
    unsignedJWT +
    "." +
    btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

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
  } catch (_error) {
    return "";
  }
};

export const getAccessToken = async (env: FirebaseTokenEnv) => {
  let accessToken: string | null = await env.FCM.get("accessToken");
  if (!accessToken) {
    accessToken = await fetchAccessToken(env.FIREBASE_ADMINSDK);
    await env.FCM.put("accessToken", accessToken, { expirationTtl: 3600 });
  }
  return accessToken;
};
