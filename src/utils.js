import { CHECKOUT_PAYLOAD_BASE, PAYURL_CHECKOUT_PAYLOAD_BASE } from "./config.js";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function extractAccessToken(value = "") {
  const session = typeof value === "string" ? parseSessionJson(value) : value;
  const accessToken = session && typeof session === "object" ? session.accessToken : "";
  if (typeof accessToken === "string" && accessToken.trim()) return accessToken.trim();
  throw new Error("GPT session 内容未包含 accessToken，请粘贴 /api/auth/session 的完整 JSON 应答。");
}

export function parseAuthSessionAccessToken(value = "") {
  return extractAccessToken(value);
}

export function convertAuthSessionToCodexSession(value = "", options = {}) {
  const session = typeof value === "string" ? parseSessionJson(value) : value;
  if (!session || typeof session !== "object") {
    throw new Error("GPT session 内容不是合法对象。");
  }

  const accessToken = readRequiredString(session.accessToken, "accessToken");
  const sessionToken = readRequiredString(session.sessionToken, "sessionToken");
  const accessClaims = decodeJwtPayload(accessToken);
  const authClaims = accessClaims["https://api.openai.com/auth"] || {};
  const profileClaims = accessClaims["https://api.openai.com/profile"] || {};
  const accountId = readFirstString(session.account?.id, authClaims.chatgpt_account_id);
  const planType = readFirstString(session.account?.planType, authClaims.chatgpt_plan_type);
  const userId = readFirstString(session.user?.id, authClaims.chatgpt_user_id, authClaims.user_id);
  const email = readFirstString(session.user?.email, profileClaims.email, accessClaims.email);
  const expired = readFirstString(session.expires, accessClaims.exp ? new Date(accessClaims.exp * 1000).toISOString() : "");
  const now = normalizeDate(options.now || new Date(), "last_refresh");

  if (!accountId) throw new Error("GPT session 内容未包含 account.id。");
  if (!email) throw new Error("GPT session 内容未包含 user.email。");
  if (!expired) throw new Error("GPT session 内容未包含 expires。");

  return {
    type: "codex",
    email,
    account_id: accountId,
    chatgpt_account_id: accountId,
    plan_type: planType || "",
    chatgpt_plan_type: planType || "",
    id_token: buildSyntheticIdToken({
      accountId,
      planType: planType || "",
      userId: userId || "",
      email,
      issuedAt: now,
      expiresAt: normalizeDate(expired, "expires"),
    }),
    access_token: accessToken,
    refresh_token: readFirstString(session.refreshToken, session.refresh_token),
    session_token: sessionToken,
    last_refresh: now.toISOString(),
    expired: normalizeDate(expired, "expires").toISOString(),
    disabled: false,
    id_token_synthetic: true,
  };
}

export function selectSessionInput(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      if (value.trim()) return value;
      continue;
    }
    if (value && typeof value === "object") return value;
  }
  return "";
}

export function normalizeCheckoutUrl(value = "") {
  const url = String(value || "").trim();
  if (!url) return "";
  if (!/^https:\/\/(?:pay\.openai\.com\/c\/pay\/|checkout\.stripe\.com\/c\/pay\/|chatgpt\.com\/checkout\/)/i.test(url)) {
    throw new Error("Checkout 链接必须是 https://pay.openai.com/c/pay/ 或 https://chatgpt.com/checkout/ 开头。");
  }
  return url;
}

function parseSessionJson(value = "") {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("缺少 GPT session 内容，请粘贴 /api/auth/session 的 JSON 应答。");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GPT session 内容不是合法 JSON，请粘贴 /api/auth/session 的完整应答。");
  }
}

function readRequiredString(value, fieldName) {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`GPT session 内容未包含 ${fieldName}。`);
}

function readFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} 不是合法时间。`);
  return date;
}

function decodeJwtPayload(token) {
  const payload = String(token || "").split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function buildSyntheticIdToken({ accountId, planType, userId, email, issuedAt, expiresAt }) {
  const header = {
    alg: "none",
    typ: "JWT",
    cpa_synthetic: true,
  };
  const payload = {
    iat: Math.floor(issuedAt.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
      chatgpt_user_id: userId,
      user_id: userId,
    },
    email,
  };
  return `${base64UrlJson(header)}.${base64UrlJson(payload)}.`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function parseSmsCode(payload = "") {
  const candidates = [];
  if (payload && typeof payload === "object") {
    candidates.push(payload.data, payload.code, payload.text, payload.message, JSON.stringify(payload));
  } else {
    candidates.push(payload);
  }
  for (const candidate of candidates) {
    const text = String(candidate || "");
    const paypalMatch = text.match(/PayPal:\s*(\d{6})\b/i);
    if (paypalMatch) return paypalMatch[1];
    const genericMatch = text.match(/\b(\d{6})\b/);
    if (genericMatch) return genericMatch[1];
  }
  return "";
}

export function randomEmail() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let local = "";
  for (let index = 0; index < 16; index += 1) {
    local += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${local}@gmail.com`;
}

export function randomPassword() {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const symbols = "!@#$%^";
  const all = `${lower}${upper}${digits}${symbols}`;
  const chars = [
    lower[Math.floor(Math.random() * lower.length)],
    upper[Math.floor(Math.random() * upper.length)],
    digits[Math.floor(Math.random() * digits.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];
  while (chars.length < 14) chars.push(all[Math.floor(Math.random() * all.length)]);
  return chars.sort(() => Math.random() - 0.5).join("");
}

export function normalizeAddress(input = {}) {
  const source = input.address || input;
  return {
    street: String(source.Address || source.street || source.address1 || "123 Main St").trim(),
    city: String(source.City || source.city || "New York").trim(),
    state: String(source.State_Full || source.State || source.state || "New York").trim(),
    zip: String(source.Zip_Code || source.zip || source.postalCode || "10001").trim().slice(0, 5),
  };
}

export function luhnCheckDigit(prefixDigits) {
  const reversed = prefixDigits.slice().reverse();
  let sum = 0;
  for (let index = 0; index < reversed.length; index += 1) {
    let digit = reversed[index];
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function randomVisaCard() {
  const digits = [4, 1, 4, 7];
  while (digits.length < 15) digits.push(Math.floor(Math.random() * 10));
  digits.push(luhnCheckDigit(digits));
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const year = (new Date().getFullYear() % 100) + Math.floor(Math.random() * 4) + 2;
  return {
    number: digits.join(""),
    expiry: `${month} / ${year}`,
    cvv: String(Math.floor(100 + Math.random() * 900)),
  };
}

export function buildCheckoutPayload() {
  return {
    ...JSON.parse(JSON.stringify(CHECKOUT_PAYLOAD_BASE)),
    checkout_ui_mode: "hosted",
    billing_details: {
      country: "US",
      currency: "USD",
    },
  };
}

export function buildPayurlCheckoutPayload(accessToken, input = {}) {
  return {
    ...JSON.parse(JSON.stringify(PAYURL_CHECKOUT_PAYLOAD_BASE)),
    token: String(accessToken || "").trim(),
    plan: input.checkoutPlan || input.plan || PAYURL_CHECKOUT_PAYLOAD_BASE.plan,
    ui_language: input.uiLanguage || input.ui_language || PAYURL_CHECKOUT_PAYLOAD_BASE.ui_language,
    country: input.country || PAYURL_CHECKOUT_PAYLOAD_BASE.country,
    currency: input.currency || PAYURL_CHECKOUT_PAYLOAD_BASE.currency,
    proxy: input.proxy || PAYURL_CHECKOUT_PAYLOAD_BASE.proxy,
    use_promo: input.usePromo === undefined ? PAYURL_CHECKOUT_PAYLOAD_BASE.use_promo : Boolean(input.usePromo),
    promo_code: input.promoCode || input.promo_code || PAYURL_CHECKOUT_PAYLOAD_BASE.promo_code,
    workspace_name: input.workspaceName || input.workspace_name || PAYURL_CHECKOUT_PAYLOAD_BASE.workspace_name,
    seat_quantity: Number(input.seatQuantity || input.seat_quantity || PAYURL_CHECKOUT_PAYLOAD_BASE.seat_quantity),
  };
}

export function findHostedCheckoutUrl(payload = {}) {
  const stack = [payload];
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const value of Object.values(current)) {
      if (typeof value === "string" && /^https:\/\/(?:pay\.openai\.com|checkout\.stripe\.com)\/c\/pay\//i.test(value.trim())) {
        return value.trim();
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

export function buildChatGptCheckoutUrl(sessionId, processorEntity = "openai_llc") {
  const cleanSessionId = String(sessionId || "").trim();
  if (!cleanSessionId) throw new Error("创建 Plus Checkout 失败：未返回 checkout_session_id。");
  return `https://chatgpt.com/checkout/${processorEntity}/${cleanSessionId}`;
}
