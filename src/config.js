export const DEFAULTS = Object.freeze({
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3217),
  chromePath: process.env.CHROME_PATH || "",
  cdpPort: Number(process.env.CHROME_REMOTE_DEBUGGING_PORT || process.env.CDP_PORT || 0),
  headless: process.env.HEADLESS === "1",
  userDataDir: process.env.CHROME_USER_DATA_DIR || "",
  smsUrl: process.env.SMS_URL || "",
  phone: process.env.PAYPAL_PHONE || "",
  cardNumber: process.env.PAYPAL_CARD_NUMBER || "",
  cardExpiry: process.env.PAYPAL_CARD_EXPIRY || "",
  cardCvv: process.env.PAYPAL_CARD_CVV || "",
  firstName: process.env.PAYPAL_FIRST_NAME || "James",
  lastName: process.env.PAYPAL_LAST_NAME || "Smith",
});

export const CHECKOUT_PAYLOAD_BASE = Object.freeze({
  entry_point: "all_plans_pricing_modal",
  plan_name: "chatgptplusplan",
  cancel_url: "https://chatgpt.com/#pricing",
  promo_campaign: {
    promo_campaign_id: "plus-1-month-free",
    is_coupon_from_query_param: false,
  },
});

export const PAYURL_CHECKOUT_ENDPOINT = "https://payurl.ark2.cn/api/checkout";

export const PAYURL_CHECKOUT_PAYLOAD_BASE = Object.freeze({
  plan: "plus",
  checkout_ui_mode: "hosted",
  ui_language: "en",
  country: "US",
  currency: "USD",
  proxy: "",
  use_promo: true,
  promo_code: "STRIPEATLASGPT4BIZ050126",
  workspace_name: "linux-do",
  seat_quantity: 2,
});

export const PAYPAL_CHECKOUT_PAYLOAD = Object.freeze({
  ...CHECKOUT_PAYLOAD_BASE,
  checkout_ui_mode: "hosted",
  billing_details: {
    country: "US",
    currency: "USD",
  },
});

export const SUCCESS_URL_RE =
  /^https:\/\/(?:chatgpt\.com|www\.chatgpt\.com|chat\.openai\.com)\/(?:backend-api\/)?payments\/success(?:[/?#]|$)/i;

export const CHECKOUT_READY_URL_RE =
  /^https:\/\/(?:chatgpt\.com\/checkout|pay\.openai\.com\/c\/pay|checkout\.stripe\.com\/c\/pay)(?:\/|$)/i;
