import test from "node:test";
import assert from "node:assert/strict";
import { COMMON_PAGE_HELPERS } from "../src/page-scripts.js";

test("common page state detects PayPal DataDome iframe captcha markup", () => {
  assert.match(COMMON_PAGE_HELPERS, /iframe\[title\*="DataDome" i\]/);
  assert.match(COMMON_PAGE_HELPERS, /iframe\[src\*="geo\.ddc\.paypal\.com\/captcha"\]/);
  assert.match(COMMON_PAGE_HELPERS, /captchaKind: datadomeCaptcha/);
});
