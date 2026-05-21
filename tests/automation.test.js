import test from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { AutoPlusJob } from "../src/automation.js";

class FakeBrowser {
  constructor(options = {}) {
    this.navigations = [];
    this.evaluations = [];
    this.failOpenAiCheckoutOnce = options.failOpenAiCheckoutOnce;
    this.failPayPalOnce = options.failPayPalOnce;
    this.states = [
      { url: "https://pay.openai.com/c/pay/cs_test_123", isOpenAiCheckout: true },
      { url: "https://www.paypal.com/pay", isPayPal: true, isPayPalLogin: true },
      { url: "https://www.paypal.com/checkoutweb/", isPayPal: true, isPayPalGuest: true },
      { url: "https://www.paypal.com/checkoutweb/", isPayPal: true, verificationInputs: 6 },
      { url: "https://chatgpt.com/payments/success?session_id=cs_test_123", success: true },
    ];
  }

  async start() {}
  async enablePage() {}
  async close() {}
  async navigate(url) {
    this.navigations.push(url);
  }
  findContextIdByOrigin(origin) {
    return 42;
  }
  async eval(expression) {
    this.evaluations.push(expression);
    if (expression === "document.readyState") return "complete";
    if (expression === "window.AutoPlus.state()") return this.states.shift() || this.states.at(-1);
    if (expression.includes("audio-captcha-track")) {
      return "https://dd.prod.ddc.paypal.com/audio/mock.wav";
    }
    if (expression.includes("autoplus-action: openai-checkout") && this.failOpenAiCheckoutOnce) {
      this.failOpenAiCheckoutOnce = false;
      throw new Error("Inspected target navigated or closed");
    }
    if (expression.includes("autoplus-action: openai-checkout")) return { clicked: true, state: this.states[0] || {} };
    if (expression.includes("guest-checkout") && this.failPayPalOnce) {
      this.failPayPalOnce = false;
      throw new Error("Promise was collected");
    }
    return {};
  }
}

test("AutoPlusJob run accepts full auth session JSON from the submitted session field", async () => {
  const browser = new FakeBrowser();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url) === "https://payurl.ark2.cn/api/checkout") {
      const body = JSON.parse(options.body);
      assert.equal(body.token, "atk_full_session_json");
      assert.equal(body.plan, "plus");
      assert.equal(body.checkout_ui_mode, "hosted");
      assert.equal(body.use_promo, true);
      assert.equal(body.promo_code, "STRIPEATLASGPT4BIZ050126");
      return jsonResponse({
        checkout_session_id: "cs_test_123",
        chatgpt_checkout_url: "https://chatgpt.com/checkout/openai_llc/cs_test_123",
        openai_payurl: "https://pay.openai.com/c/pay/cs_test_123",
      });
    }
    if (String(url).includes("meiguodizhi.com")) {
      return jsonResponse({ address: { Address: "1 Main", City: "Austin", State_Full: "Texas", Zip_Code: "73301" } });
    }
    if (String(url).includes("62-us.test")) {
      return textResponse("yes|PayPal: 394662 is your security code.");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const job = new AutoPlusJob("1", {
    gptSession: "",
    sessionToken: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: fetchImpl,
    sleep: async () => {},
  });

  await job.run();

  assert.ok(!requests.some((request) => request.url.includes("/api/auth/session")));
  assert.ok(requests.some((request) => request.url === "https://payurl.ark2.cn/api/checkout"));
  assert.equal(browser.navigations.at(-1), "https://pay.openai.com/c/pay/cs_test_123");
  assert.ok(browser.evaluations.some((expression) => expression.includes("openai-checkout")));
  assert.ok(browser.evaluations.some((expression) => expression.includes("guest-checkout")));
  assert.ok(browser.evaluations.some((expression) => expression.includes("394662")));
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.successUrl, "https://chatgpt.com/payments/success?session_id=cs_test_123");
});

test("AutoPlusJob continues when checkout script triggers PayPal navigation", async () => {
  const browser = new FakeBrowser({ failOpenAiCheckoutOnce: true });
  const job = new AutoPlusJob("nav", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) {
        return jsonResponse({ address: { Address: "1 Main", City: "Austin", State_Full: "Texas", Zip_Code: "73301" } });
      }
      if (String(url).includes("62-us.test")) {
        return textResponse("yes|PayPal: 394662 is your security code.");
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(job.logs.some((entry) => entry.message === "页面正在跳转，等待新页面加载后继续。"));
});

test("AutoPlusJob continues when PayPal script promise is collected", async () => {
  const browser = new FakeBrowser({ failPayPalOnce: true });
  const job = new AutoPlusJob("promise-collected", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) {
        return jsonResponse({ address: { Address: "1 Main", City: "Austin", State_Full: "Texas", Zip_Code: "73301" } });
      }
      if (String(url).includes("62-us.test")) {
        return textResponse("yes|PayPal: 394662 is your security code.");
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(job.logs.some((entry) => entry.message === "页面正在跳转，等待新页面加载后继续。"));
});

test("AutoPlusJob uses manually provided sms code text before polling", async () => {
  const browser = new FakeBrowser();
  const requests = [];
  const job = new AutoPlusJob("sms", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
    smsCode: "yes|PayPal: 973387 is your security code. Don't share it.|(PayPal)|到期时间：2026-06-29 00:00:00",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      requests.push(String(url));
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(browser.evaluations.some((expression) => expression.includes("973387")));
  assert.ok(!requests.some((url) => url.includes("62-us.test")));
});

test("AutoPlusJob accepts an existing hosted checkout url without GPT session", async () => {
  const browser = new FakeBrowser();
  const checkoutUrl = "https://pay.openai.com/c/pay/cs_existing";
  const job = new AutoPlusJob("checkout-url", {
    checkoutUrl,
    smsCode: "973387",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.equal(browser.navigations[0], checkoutUrl);
  assert.ok(!browser.evaluations.some((expression) => expression.includes("backend-api/payments/checkout")));
  assert.equal(job.result.checkout.preferredCheckoutUrl, checkoutUrl);
});

test("AutoPlusJob stops after hosted checkout returns to ChatGPT home", async () => {
  const browser = new FakeBrowser();
  browser.states = [
    { url: "https://pay.openai.com/c/pay/cs_existing", isOpenAiCheckout: true },
    { url: "https://chatgpt.com/" },
  ];
  const job = new AutoPlusJob("checkout-home", {
    checkoutUrl: "https://pay.openai.com/c/pay/cs_existing",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.equal(job.result.successUrl, "https://chatgpt.com/");
  assert.ok(job.logs.some((entry) => entry.message === "已离开 hosted checkout 并回到 ChatGPT，自动订阅点击流程结束。"));
});

test("AutoPlusJob pauses on PayPal captcha and resumes after manual verification", async () => {
  const browser = new FakeBrowser();
  browser.states = [
    { url: "https://pay.openai.com/c/pay/cs_test_123", isOpenAiCheckout: true },
    { url: "https://www.paypal.com/checkoutweb/", isPayPal: true, hasCaptcha: true, captchaKind: "datadome" },
    { url: "https://www.paypal.com/checkoutweb/", isPayPal: true, hasCaptcha: false, isPayPalGuest: true },
    { url: "https://chatgpt.com/payments/success?session_id=cs_test_123", success: true },
  ];
  const job = new AutoPlusJob("captcha", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsCode: "973387",
    captchaPrompt: true,
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(job.logs.some((entry) => entry.message.includes("检测到安全验证")));
  assert.ok(browser.evaluations.some((expression) => expression.includes("autoplus-action: captcha-prompt")));
  const captchaPromptIndex = browser.evaluations.findIndex((expression) => expression.includes("autoplus-action: captcha-prompt"));
  const paypalActionAfterCaptcha = browser.evaluations.findIndex((expression, index) => {
    return index > captchaPromptIndex && expression.includes("guest-checkout");
  });
  assert.ok(paypalActionAfterCaptcha > captchaPromptIndex);
});

test("AutoPlusJob supports silent manual captcha mode without page prompt", async () => {
  const browser = new FakeBrowser();
  browser.states = [
    { url: "https://pay.openai.com/c/pay/cs_test_123", isOpenAiCheckout: true },
    { url: "https://www.paypal.com/checkoutweb/", isPayPal: true, hasCaptcha: true, captchaKind: "datadome" },
    { url: "https://chatgpt.com/payments/success?session_id=cs_test_123", success: true },
  ];
  const job = new AutoPlusJob("captcha-silent", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    captchaMode: "manual_silent",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(job.logs.some((entry) => entry.message.includes("检测到安全验证")));
  assert.ok(!browser.evaluations.some((expression) => expression.includes("autoplus-action: captcha-prompt")));
});

test("AutoPlusJob downgrades failed auto captcha mode to manual waiting", async () => {
  const browser = new FakeBrowser();
  browser.states = [
    { url: "https://pay.openai.com/c/pay/cs_test_123", isOpenAiCheckout: true },
    { url: "https://www.paypal.com/checkoutweb/", isPayPal: true, hasCaptcha: true, captchaKind: "datadome" },
    { url: "https://chatgpt.com/payments/success?session_id=cs_test_123", success: true },
  ];
  const job = new AutoPlusJob("captcha-auto-fallback", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    captchaMode: "auto",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      if (String(url).includes("mock.wav")) {
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return Buffer.from("mock wave body");
          }
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    exec: (cmd, callback) => {
      callback(new Error("codex exec error"));
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(job.logs.some((entry) => entry.message.includes("全自动语音提取方案失败")));
  assert.ok(browser.evaluations.some((expression) => expression.includes("autoplus-action: captcha-prompt")));
});

test("AutoPlusJob can drag captcha sliders only on non-PayPal test pages", async () => {
  const browser = new FakeBrowser();
  browser.states = [
    { url: "https://pay.openai.com/c/pay/cs_test_123", isOpenAiCheckout: true },
    { url: "https://sandbox.local/checkoutweb/", host: "sandbox.local", isPayPal: true, hasCaptcha: true, captchaKind: "datadome" },
    { url: "https://sandbox.local/checkoutweb/", host: "sandbox.local", isPayPal: true, isPayPalGuest: true },
    { url: "https://chatgpt.com/payments/success?session_id=cs_test_123", success: true },
  ];
  const job = new AutoPlusJob("captcha-test-assume", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    captchaMode: "test_assume_solved",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(job.logs.some((entry) => entry.message.includes("测试模式：正在自动拖动测试页面滑块")));
  assert.ok(browser.evaluations.some((expression) => expression.includes("autoplus-action: test-captcha-slide")));
  assert.ok(!browser.evaluations.some((expression) => expression.includes("autoplus-action: captcha-prompt")));
  assert.ok(browser.evaluations.some((expression) => expression.includes("guest-checkout")));
});

test("AutoPlusJob decodes compressed sms polling response", async () => {
  const browser = new FakeBrowser();
  const compressed = gzipSync(Buffer.from("yes|PayPal: 973387 is your security code. Don't share it.|(PayPal)|到期时间：2026-06-29 00:00:00"));
  const job = new AutoPlusJob("sms-gzip", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      if (String(url).includes("62-us.test")) {
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              return name.toLowerCase() === "content-encoding" ? "gzip" : "";
            },
          },
          async arrayBuffer() {
            return compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(browser.evaluations.some((expression) => expression.includes("973387")));
  assert.ok(job.logs.some((entry) => entry.message.includes("短信接口第 1 次响应：HTTP 200 yes|PayPal: 973387")));
});

test("AutoPlusJob reports checkout fetch network failure details", async () => {
  const cause = new Error("getaddrinfo ENOTFOUND payurl.ark2.cn");
  cause.code = "ENOTFOUND";
  const job = new AutoPlusJob("2", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
  }, {
    fetch: async () => {
      throw new TypeError("fetch failed", { cause });
    },
    sleep: async () => {},
  });

  await assert.rejects(
    () => job.createCheckout("atk_full_session_json"),
    /创建 Plus Checkout 网络请求失败：fetch failed \/ ENOTFOUND \/ getaddrinfo ENOTFOUND payurl\.ark2\.cn/,
  );
});

test("AutoPlusJob includes checkout failure response body", async () => {
  const job = new AutoPlusJob("3", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
  }, {
    fetch: async () => textResponse("request blocked by upstream", 403),
    sleep: async () => {},
  });

  await assert.rejects(
    () => job.createCheckout("atk_full_session_json"),
    /创建 Plus Checkout 失败：HTTP 403：request blocked by upstream/,
  );
});

test("AutoPlusJob decodes compressed checkout failure response body", async () => {
  const compressed = brotliCompressSync(Buffer.from("forbidden by upstream"));
  const job = new AutoPlusJob("4", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
  }, {
    fetch: async () => ({
      ok: false,
      status: 403,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-encoding" ? "br" : "";
        },
      },
      async arrayBuffer() {
        return compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
      },
    }),
    sleep: async () => {},
  });

  await assert.rejects(
    () => job.createCheckout("atk_full_session_json"),
    /创建 Plus Checkout 失败：HTTP 403：forbidden by upstream/,
  );
});

test("AutoPlusJob decodes zstd checkout failure response body", async () => {
  const compressed = zstdCompressSync(Buffer.from("zstd forbidden by upstream"));
  const job = new AutoPlusJob("5", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
  }, {
    fetch: async () => ({
      ok: false,
      status: 403,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-encoding" ? "zstd" : "";
        },
      },
      async arrayBuffer() {
        return compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
      },
    }),
    sleep: async () => {},
  });

  await assert.rejects(
    () => job.createCheckout("atk_full_session_json"),
    /创建 Plus Checkout 失败：HTTP 403：zstd forbidden by upstream/,
  );
});

test("AutoPlusJob tries compressed checkout failure decoding without encoding header", async () => {
  const compressed = brotliCompressSync(Buffer.from("brotli body without header"));
  const job = new AutoPlusJob("6", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
  }, {
    fetch: async () => ({
      ok: false,
      status: 403,
      headers: {
        get() {
          return "";
        },
      },
      async arrayBuffer() {
        return compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
      },
    }),
    sleep: async () => {},
  });

  await assert.rejects(
    () => job.createCheckout("atk_full_session_json"),
    /创建 Plus Checkout 失败：HTTP 403：brotli body without header/,
  );
});

function fullAuthSessionResponse() {
  return {
    WARNING_BANNER: "DO NOT SHARE ANY PART OF THE INFORMATION YOU SEE HERE.",
    user: {
      id: "user-test",
      name: "Test User",
      email: "user@example.com",
      idp: "auth0",
      iat: 1779251115,
      mfa: false,
    },
    expires: "2026-08-18T04:25:25.097Z",
    account: {
      id: "account-test",
      planType: "free",
      structure: "personal",
    },
    accessToken: "atk_full_session_json",
    authProvider: "openai",
    sessionToken: "encrypted-session-token-value",
    rumViewTags: {
      light_account: { fetched: false },
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function checkoutResponse() {
  return jsonResponse({
    checkout_session_id: "cs_test_123",
    chatgpt_checkout_url: "https://chatgpt.com/checkout/openai_llc/cs_test_123",
    openai_payurl: "https://pay.openai.com/c/pay/cs_test_123",
  });
}

function textResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(payload);
    },
    async text() {
      return payload;
    },
  };
}

test("AutoPlusJob control pause and resume halts and continues execution", async () => {
  const browser = new FakeBrowser();
  
  const job = new AutoPlusJob("pause-resume-test", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      if (String(url).includes("62-us.test")) {
        return textResponse("yes|PayPal: 394662 is your security code.");
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  // 启动任务并让其在后台运行
  const runPromise = job.run();
  
  // 触发暂停，并断言状态为 paused
  job.pause();
  assert.equal(job.status, "paused");
  
  // 触发恢复，并断言状态重新为 running
  job.resume();
  assert.equal(job.status, "running");
  
  await runPromise;
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.gptEmail, "user@example.com"); // 验证正确解析了 gptSession 中的真实 email
});

test("AutoPlusJob control stop halts execution immediately", async () => {
  const browser = new FakeBrowser();
  
  const job = new AutoPlusJob("stop-test", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      if (String(url).includes("62-us.test")) {
        return textResponse("yes|PayPal: 394662 is your security code.");
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  // 启动任务并让其在后台运行
  const runPromise = job.run();
  
  // 触发停止，并断言状态为 stopped
  await job.stop();
  assert.equal(job.status, "stopped");
  
  // 确保 run() 正常返回，不会因为被停止而对外抛出异常
  await runPromise;
  assert.equal(job.status, "stopped");
});

test("AutoPlusJob successfully extracts 6 digits using whisper", async () => {
  const browser = new FakeBrowser();
  browser.states = [
    { url: "https://pay.openai.com/c/pay/cs_test_123", isOpenAiCheckout: true },
    { url: "https://www.paypal.com/checkoutweb/", isPayPal: true, hasCaptcha: true, captchaKind: "datadome" },
    { url: "https://chatgpt.com/payments/success?session_id=cs_test_123", success: true },
  ];
  
  const job = new AutoPlusJob("captcha-auto-success", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    captchaMode: "auto",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      if (String(url).includes("mock.wav")) {
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return Buffer.from("mock wave body");
          }
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    exec: (cmd, callback) => {
      // 从命令行参数中提取出 wav 的临时路径，并在同名 txt 中写入识别的 6 位数字以模拟真实执行
      const match = cmd.match(/"([^"]+\.wav)"/);
      if (match) {
        const wavPath = match[1];
        const tempDir = path.dirname(wavPath);
        const baseName = path.basename(wavPath, ".wav");
        const txtPath = path.join(tempDir, baseName + ".txt");
        fs.writeFileSync(txtPath, "识别出的数字发音为 654321");
      }
      callback(null, "whisper transcription finished", "");
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(job.logs.some((entry) => entry.message.includes("本地识别成功，解出数字: 654321")));
  assert.ok(browser.evaluations.some((expression) => expression.includes("654321")));
});

test("AutoPlusJob run in non-headless mode closes the browser upon completion", async () => {
  let closeCalled = false;
  const browser = new FakeBrowser();
  browser.close = async () => {
    closeCalled = true;
  };

  const job = new AutoPlusJob("non-headless-success", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
    headless: false, // 显式使用有头（非无头）模式
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      if (String(url).includes("62-us.test")) return textResponse("yes|PayPal: 394662 is your security code.");
      throw new Error(`unexpected fetch ${url}`);
    },
    sleep: async () => {},
  });

  await job.run();
  assert.equal(job.status, "succeeded");
  assert.ok(closeCalled); // 验证已关闭浏览器
});

test("AutoPlusJob run in non-headless mode closes the browser upon failure", async () => {
  let closeCalled = false;
  const browser = new FakeBrowser();
  browser.close = async () => {
    closeCalled = true;
  };

  const job = new AutoPlusJob("non-headless-failure", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    smsUrl: "https://62-us.test/get_sms",
    headless: false, // 显式使用有头（非无头）模式
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async () => {
      throw new Error("Simulated network failure");
    },
    sleep: async () => {},
  });

  await assert.rejects(() => job.run(), /Simulated network failure/);
  assert.equal(job.status, "failed");
  assert.ok(closeCalled); // 验证失败时也已关闭浏览器
});

test("AutoPlusJob successfully extracts 6 digits using whisper from Chinese numerals with separators", async () => {
  const browser = new FakeBrowser();
  browser.states = [
    { url: "https://pay.openai.com/c/pay/cs_test_123", isOpenAiCheckout: true },
    { url: "https://www.paypal.com/checkoutweb/", isPayPal: true, hasCaptcha: true, captchaKind: "datadome" },
    { url: "https://chatgpt.com/payments/success?session_id=cs_test_123", success: true },
  ];
  
  const job = new AutoPlusJob("captcha-auto-chinese-success", {
    gptSession: JSON.stringify(fullAuthSessionResponse()),
    captchaMode: "auto",
  }, {
    Browser: class extends FakeBrowser {
      constructor() {
        super();
        return browser;
      }
    },
    fetch: async (url) => {
      if (String(url) === "https://payurl.ark2.cn/api/checkout") return checkoutResponse();
      if (String(url).includes("meiguodizhi.com")) return jsonResponse({});
      if (String(url).includes("mock.wav")) {
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return Buffer.from("mock wave body");
          }
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    exec: (cmd, callback) => {
      const match = cmd.match(/"([^"]+\.wav)"/);
      if (match) {
        const wavPath = match[1];
        const tempDir = path.dirname(wavPath);
        const baseName = path.basename(wavPath, ".wav");
        const txtPath = path.join(tempDir, baseName + ".txt");
        // 模拟转写出来的是带有顿号、空格和中文数字汉字的复杂字符串
        fs.writeFileSync(txtPath, "识别出的数字发音为： 三、九、四、 六、六、二  。");
      }
      callback(null, "whisper transcription finished", "");
    },
    sleep: async () => {},
  });

  await job.run();

  assert.equal(job.status, "succeeded");
  assert.ok(job.logs.some((entry) => entry.message.includes("本地识别成功，解出数字: 394662")));
  assert.ok(browser.evaluations.some((expression) => expression.includes("394662")));
});


