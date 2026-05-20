import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAccessToken,
  buildChatGptCheckoutUrl,
  buildCheckoutPayload,
  buildPayurlCheckoutPayload,
  convertAuthSessionToCodexSession,
  findHostedCheckoutUrl,
  luhnCheckDigit,
  normalizeAddress,
  parseAuthSessionAccessToken,
  parseSmsCode,
} from "../src/utils.js";

test("extractAccessToken treats GPT session input as /api/auth/session response", () => {
  assert.equal(
    extractAccessToken(JSON.stringify({ user: { email: "user@example.com" }, accessToken: "atk_live_123" })),
    "atk_live_123",
  );
  assert.equal(
    extractAccessToken({ accessToken: "atk_object_456" }),
    "atk_object_456",
  );
  assert.throws(
    () => extractAccessToken("__Secure-next-auth.session-token=old-cookie-value"),
    /不是合法 JSON|未包含 accessToken/,
  );
});

test("parseAuthSessionAccessToken reads accessToken from pasted auth session response", () => {
  assert.equal(
    parseAuthSessionAccessToken('{"user":{"email":"a@example.com"},"accessToken":"token-123"}'),
    "token-123",
  );
  assert.equal(
    parseAuthSessionAccessToken(JSON.stringify({
      WARNING_BANNER: "DO NOT SHARE ANY PART OF THE INFORMATION YOU SEE HERE.",
      user: { email: "a@example.com" },
      account: { planType: "free" },
      accessToken: "token-full-response",
      sessionToken: "encrypted-session-token-value",
      rumViewTags: { light_account: { fetched: false } },
    })),
    "token-full-response",
  );
  assert.equal(
    parseAuthSessionAccessToken({ accessToken: "token-456" }),
    "token-456",
  );
});

test("convertAuthSessionToCodexSession maps auth session fields into codex session shape", () => {
  const converted = convertAuthSessionToCodexSession({
    user: { id: "user_123", email: "user@example.com" },
    expires: "2026-08-18T10:26:13.095Z",
    account: { id: "acct_123", planType: "plus" },
    accessToken: "access_token_value",
    sessionToken: "session_token_value",
  }, {
    now: new Date("2026-05-20T10:28:19.444Z"),
  });

  assert.equal(converted.type, "codex");
  assert.equal(converted.email, "user@example.com");
  assert.equal(converted.account_id, "acct_123");
  assert.equal(converted.chatgpt_account_id, "acct_123");
  assert.equal(converted.plan_type, "plus");
  assert.equal(converted.chatgpt_plan_type, "plus");
  assert.equal(converted.access_token, "access_token_value");
  assert.equal(converted.refresh_token, "");
  assert.equal(converted.session_token, "session_token_value");
  assert.equal(converted.last_refresh, "2026-05-20T10:28:19.444Z");
  assert.equal(converted.expired, "2026-08-18T10:26:13.095Z");
  assert.equal(converted.disabled, false);
  assert.equal(converted.id_token_synthetic, true);

  const [headerPart, payloadPart, signaturePart] = converted.id_token.split(".");
  assert.equal(signaturePart, "");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: "none", typ: "JWT", cpa_synthetic: true });
  assert.equal(payload.email, "user@example.com");
  assert.equal(payload.iat, 1779272899);
  assert.equal(payload.exp, 1787048773);
  assert.deepEqual(payload["https://api.openai.com/auth"], {
    chatgpt_account_id: "acct_123",
    chatgpt_plan_type: "plus",
    chatgpt_user_id: "user_123",
    user_id: "user_123",
  });
});

test("convertAuthSessionToCodexSession accepts JSON string input and validates required tokens", () => {
  const converted = convertAuthSessionToCodexSession(JSON.stringify({
    user: { email: "string@example.com" },
    expires: "2026-08-18T10:26:13.095Z",
    account: { id: "acct_string", planType: "free" },
    accessToken: "access_from_string",
    sessionToken: "session_from_string",
  }), {
    now: "2026-05-20T10:28:19.444Z",
  });

  assert.equal(converted.email, "string@example.com");
  assert.equal(converted.account_id, "acct_string");
  assert.equal(converted.access_token, "access_from_string");
  assert.equal(converted.session_token, "session_from_string");
  assert.throws(
    () => convertAuthSessionToCodexSession({ accessToken: "only_access" }),
    /未包含 sessionToken/,
  );
});

test("parseSmsCode extracts PayPal code from 62-us text response", () => {
  assert.equal(
    parseSmsCode("yes|PayPal: 394662 is your security code. Don't share it.|(PayPal)|到期时间：2026-06-29 00:00:00"),
    "394662",
  );
});

test("checkout helpers match GuJumpgate hosted PayPal shape", () => {
  assert.deepEqual(buildCheckoutPayload().billing_details, { country: "US", currency: "USD" });
  assert.equal(buildCheckoutPayload().checkout_ui_mode, "hosted");
  assert.equal(buildCheckoutPayload().cancel_url, "https://chatgpt.com/#pricing");
  assert.deepEqual(buildCheckoutPayload().promo_campaign, {
    promo_campaign_id: "plus-1-month-free",
    is_coupon_from_query_param: false,
  });
  assert.equal(
    findHostedCheckoutUrl({ nested: { url: "https://pay.openai.com/c/pay/cs_test_123" } }),
    "https://pay.openai.com/c/pay/cs_test_123",
  );
  assert.equal(
    buildChatGptCheckoutUrl("cs_123"),
    "https://chatgpt.com/checkout/openai_llc/cs_123",
  );
});

test("payurl checkout payload uses access token and promo defaults", () => {
  assert.deepEqual(buildPayurlCheckoutPayload("atk_test"), {
    token: "atk_test",
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
});

test("address and card utility behavior is stable", () => {
  assert.deepEqual(
    normalizeAddress({ address: { Address: "1 Main", City: "Austin", State_Full: "Texas", Zip_Code: "73301-1234" } }),
    { street: "1 Main", city: "Austin", state: "Texas", zip: "73301" },
  );
  const prefix = [4, 1, 4, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const number = [...prefix, luhnCheckDigit(prefix)].join("");
  let sum = 0;
  [...number].reverse().forEach((char, index) => {
    let digit = Number(char);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  });
  assert.equal(sum % 10, 0);
});
