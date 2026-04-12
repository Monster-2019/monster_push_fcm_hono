type Bindings = {
  QSTASH_TOKEN: string;
  QSTASH_URL?: string;
  QSTASH_CURRENT_SIGNING_KEY?: string;
  QSTASH_NEXT_SIGNING_KEY?: string;
  UPSTASH_WORKFLOW_URL?: string;
  FIREBASE_ADMINSDK: string;
  FCM: KVNamespace;
  HMAC_SECRET: string;
};

type FirebaseTokenEnv = {
  FIREBASE_ADMINSDK: string;
  FCM: KVNamespace;
};
