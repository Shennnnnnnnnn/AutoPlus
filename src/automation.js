import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import { CdpBrowser } from "./cdp.js";
import {
  DEFAULTS,
  PAYURL_CHECKOUT_ENDPOINT,
  SUCCESS_URL_RE,
} from "./config.js";
import {
  buildChatGptCheckoutUrl,
  buildPayurlCheckoutPayload,
  extractAccessToken,
  findHostedCheckoutUrl,
  normalizeAddress,
  normalizeCheckoutUrl,
  parseSmsCode,
  randomEmail,
  randomPassword,
  randomVisaCard,
  selectSessionInput,
  sleep,
} from "./utils.js";
import { createProxyAwareFetch } from "./proxy-fetch.js";
import {
  COMMON_PAGE_HELPERS,
  captchaPromptExpression,
  fillVerificationExpression,
  openAiCheckoutStepExpression,
  payPalStepExpression,
  testCaptchaSlideExpression,
} from "./page-scripts.js";

const ADDRESS_ENDPOINT = "https://www.meiguodizhi.com/api/v1/dz";

export class AutoPlusJob {
  constructor(id, input = {}, dependencies = {}) {
    this.id = id;
    this.input = input;
    this.Browser = dependencies.Browser || CdpBrowser;
    this.fetch = dependencies.fetch || createProxyAwareFetch();
    this.sleep = dependencies.sleep || sleep;
    this.status = "queued";
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.logs = [];
    this.result = null;
    this.error = "";
    this.browser = null;
  }

  log(message, level = "info") {
    this.updatedAt = new Date().toISOString();
    this.logs.push({ at: this.updatedAt, level, message });
    if (this.logs.length > 500) this.logs.shift();
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      logs: this.logs,
      result: this.result,
      error: this.error,
    };
  }

  async run() {
    this.status = "running";
    this.log("任务启动：准备解析 GPT session JSON。");
    try {
      const providedCheckoutUrl = normalizeCheckoutUrl(
        this.input.checkoutUrl || this.input.payOpenAiUrl || "",
      );

      this.browser = new this.Browser({
        chromePath: this.input.chromePath || DEFAULTS.chromePath,
        port: Number(this.input.cdpPort || DEFAULTS.cdpPort || 0) || undefined,
        connectOnly: Boolean(this.input.cdpPort || DEFAULTS.cdpPort),
        headless: Boolean(this.input.headless ?? DEFAULTS.headless),
        userDataDir: this.input.userDataDir || DEFAULTS.userDataDir,
      });
      await this.browser.start();
      await this.browser.enablePage();

      const checkout = providedCheckoutUrl
        ? this.buildProvidedCheckout(providedCheckoutUrl)
        : await this.createCheckoutFromSessionInput();
      this.result = { checkout };
      this.log(`Checkout 已创建：${checkout.preferredCheckoutUrl}`);

      const address = await this.fetchAddress();
      const profile = this.buildGuestProfile(address);
      this.result.profile = {
        email: profile.email,
        phone: profile.phone,
        address: profile.address,
      };

      await this.browser.navigate(checkout.preferredCheckoutUrl);
      await this.driveHostedCheckout(profile);

      this.status = "succeeded";
      this.updatedAt = new Date().toISOString();
      this.log("已检测到 ChatGPT 支付成功回跳，自动订阅流程完成。", "ok");
    } catch (error) {
      this.status = "failed";
      this.error = error?.message || String(error);
      this.updatedAt = new Date().toISOString();
      this.log(`任务失败：${this.error}`, "error");
      throw error;
    }
  }

  async createCheckoutFromSessionInput() {
    const accessToken = extractAccessToken(
      selectSessionInput(this.input.gptSession, this.input.sessionToken),
    );
    this.log(
      "已从用户填入的 /api/auth/session 应答解析 accessToken，开始通过 payurl 创建 Plus Checkout。",
    );
    return this.createCheckout(accessToken);
  }

  buildProvidedCheckout(checkoutUrl) {
    this.log("已使用用户填入的 checkout 链接，跳过 Plus Checkout 创建。");
    return {
      checkoutSessionId: extractCheckoutSessionId(checkoutUrl),
      hostedCheckoutUrl:
        /^https:\/\/(?:pay\.openai\.com|checkout\.stripe\.com)\/c\/pay\//i.test(
          checkoutUrl,
        )
          ? checkoutUrl
          : "",
      convertedCheckoutUrl: /^https:\/\/chatgpt\.com\/checkout\//i.test(
        checkoutUrl,
      )
        ? checkoutUrl
        : "",
      preferredCheckoutUrl: checkoutUrl,
    };
  }

  async waitForPageReady(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.browser
        .eval("document.readyState")
        .catch(() => "");
      if (ready === "complete" || ready === "interactive") return;
      await this.sleep(300);
    }
    throw new Error("页面加载超时。");
  }

  async createCheckout(accessToken) {
    let response;
    try {
      response = await this.fetch(PAYURL_CHECKOUT_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "Content-Type": "application/json",
          Origin: "https://payurl.ark2.cn",
          Pragma: "no-cache",
          Referer: "https://payurl.ark2.cn/",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
          "sec-ch-ua":
            '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"macOS"',
        },
        body: JSON.stringify(
          buildPayurlCheckoutPayload(accessToken, this.input),
        ),
      });
    } catch (error) {
      throw new Error(
        `创建 Plus Checkout 网络请求失败：${formatFetchError(error)}`,
        { cause: error },
      );
    }
    const { data, bodyText } = await readJsonResponse(response);
    if (!response.ok || !data.checkout_session_id) {
      const reason =
        data.detail ||
        data.message ||
        [`HTTP ${response.status}`, bodyText && bodyText.slice(0, 300)]
          .filter(Boolean)
          .join("：");
      throw new Error(`创建 Plus Checkout 失败：${reason}`);
    }
    const checkoutSessionId = data.checkout_session_id;
    const hostedCheckoutUrl =
      data.openai_payurl || data.url || findHostedCheckoutUrl(data);
    const convertedCheckoutUrl =
      data.chatgpt_checkout_url ||
      buildChatGptCheckoutUrl(
        checkoutSessionId,
        data.processor_entity || "openai_llc",
      );
    return {
      checkoutSessionId,
      hostedCheckoutUrl,
      openaiPayurl: data.openai_payurl || "",
      convertedCheckoutUrl,
      preferredCheckoutUrl: hostedCheckoutUrl || convertedCheckoutUrl,
    };
  }

  async fetchAddress() {
    this.log("正在从 meiguodizhi.com 获取美国账单地址。");
    try {
      const response = await this.fetch(ADDRESS_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "/", method: "address" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const address = normalizeAddress(data);
      this.log(`账单地址：${address.city}, ${address.state} ${address.zip}`);
      return address;
    } catch (error) {
      this.log(
        `地址接口失败，使用兜底地址：${error?.message || error}`,
        "warn",
      );
      return normalizeAddress({});
    }
  }

  buildGuestProfile(address) {
    const card = {
      number: String(
        this.input.cardNumber || DEFAULTS.cardNumber || "",
      ).replace(/\s+/g, ""),
      expiry: String(this.input.cardExpiry || DEFAULTS.cardExpiry || "").trim(),
      cvv: String(this.input.cardCvv || DEFAULTS.cardCvv || "").trim(),
    };
    const generated = randomVisaCard();
    return {
      email: this.input.email || randomEmail(),
      password: this.input.password || randomPassword(),
      phone: String(this.input.phone || DEFAULTS.phone).trim(),
      firstName: this.input.firstName || DEFAULTS.firstName,
      lastName: this.input.lastName || DEFAULTS.lastName,
      cardNumber: card.number || generated.number,
      cardExpiry: card.expiry || generated.expiry,
      cardCvv: card.cvv || generated.cvv,
      address,
    };
  }

  async pollSmsCode() {
    const directCode = parseSmsCode(
      this.input.smsCode || this.input.smsText || "",
    );
    if (directCode) {
      this.log("已从手动填写的验证码内容取得 6 位验证码。");
      return directCode;
    }
    const smsUrl = String(this.input.smsUrl || DEFAULTS.smsUrl || "").trim();
    const codeFromSmsInput = parseSmsCode(smsUrl);
    if (codeFromSmsInput) {
      this.log("已从验证码接收链接输入内容中取得 6 位验证码。");
      return codeFromSmsInput;
    }
    if (!smsUrl) throw new Error("缺少验证码接收链接。");
    const deadline = Date.now() + 90000;
    let lastText = "";
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      const separator = smsUrl.includes("?") ? "&" : "?";
      const response = await this.fetch(
        `${smsUrl}${separator}t=${Date.now()}`,
        {
          headers: { Accept: "application/json,text/plain,*/*" },
        },
      );
      const text = await readResponseText(response);
      lastText = text;
      this.log(
        `短信接口第 ${attempts} 次响应：HTTP ${response.status || 0} ${text.slice(0, 120)}`,
        "warn",
      );
      let payload = text;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {}
      const code = parseSmsCode(payload);
      if (code) {
        this.log("已从验证码接收链接取得 6 位验证码。");
        return code;
      }
      await this.sleep(5000);
    }
    throw new Error(`验证码轮询超时，最后响应：${lastText.slice(0, 120)}`);
  }

  async pageState() {
    await this.browser.eval(COMMON_PAGE_HELPERS).catch(() => {});
    return this.browser.eval("window.AutoPlus.state()");
  }

  async driveHostedCheckout(profile) {
    const deadline = Date.now() + 12 * 60 * 1000;
    let lastAction = "";
    let captchaPrompted = false;
    let unsupportedAutoCaptchaLogged = false;
    let submittedHostedCheckout = false;
    while (Date.now() < deadline) {
      await this.waitForPageReady(45000).catch(() => {});
      const state = (await this.pageState().catch(() => ({}))) || {};
      const url = String(state.url || "");
      if (SUCCESS_URL_RE.test(url) || state.success) {
        this.result.successUrl = url;
        return;
      }
      if (
        submittedHostedCheckout &&
        /^https:\/\/(?:chatgpt\.com|www\.chatgpt\.com)\/?(?:[?#].*)?$/i.test(
          url,
        )
      ) {
        this.result.successUrl = url;
        this.log(
          "已离开 hosted checkout 并回到 ChatGPT，自动订阅点击流程结束。",
          "ok",
        );
        return;
      }

      if (state.hasCaptcha) {
        const captchaMode = normalizeCaptchaMode(this.input);
        if (captchaMode === "test_assume_solved" && !isRealPayPalHost(state.host)) {
          this.log("测试模式：正在自动拖动测试页面滑块。", "warn");
          await this.evalDuringNavigation(testCaptchaSlideExpression());
          await this.sleep(500);
          continue;
        }
        if (captchaMode === "auto" && !unsupportedAutoCaptchaLogged) {
          unsupportedAutoCaptchaLogged = true;
          this.log(
            "不支持自动完成 PayPal 验证码，已切换为人工验证等待。",
            "warn",
          );
        }
        if (lastAction !== "captcha") {
          this.log(
            "检测到 PayPal 验证码，请在浏览器中手动完成验证；验证消失后会自动继续。",
            "warn",
          );
          lastAction = "captcha";
        }
        if (!captchaPrompted && shouldShowCaptchaPrompt(this.input)) {
          captchaPrompted = true;
          await this.evalDuringNavigation(
            captchaPromptExpression(
              "AutoPlus 已暂停：请手动完成 PayPal 验证码，完成后流程会自动继续。",
            ),
          );
        }
        await this.sleep(3000);
        continue;
      }

      if (state.verificationInputs >= 6) {
        this.log("检测到验证码输入框，开始轮询短信验证码。");
        const code = await this.pollSmsCode();
        await this.evalDuringNavigation(fillVerificationExpression(code));
        await this.sleep(1500);
        continue;
      }

      if (state.isOpenAiCheckout) {
        if (lastAction !== "openai-checkout")
          this.log(
            "正在 hosted checkout 页面选择 PayPal、填写账单地址并提交。",
          );
        lastAction = "openai-checkout";
        const result = await this.evalDuringNavigation(
          openAiCheckoutStepExpression(JSON.stringify(profile.address)),
        );
        if (result?.clicked) submittedHostedCheckout = true;
        await this.sleep(3000);
        continue;
      }

      if (state.isPayPal) {
        if (lastAction !== "paypal")
          this.log(
            "已进入 PayPal，正在按登录/游客卡支付/账单确认阶段自动处理。",
          );
        lastAction = "paypal";
        await this.evalDuringNavigation(
          payPalStepExpression(JSON.stringify(profile)),
        );
        await this.sleep(3000);
        continue;
      }

      this.log(
        `等待跳转到 OpenAI/PayPal/成功页，当前 URL：${url || "(未知)"}`,
        "warn",
      );
      await this.sleep(2000);
    }
    throw new Error("自动订阅流程超时，未检测到支付成功回跳。");
  }

  async evalDuringNavigation(expression) {
    try {
      return await this.browser.eval(expression);
    } catch (error) {
      if (!isRecoverableNavigationError(error)) throw error;
      this.log("页面正在跳转，等待新页面加载后继续。", "warn");
      await this.sleep(2500);
      return null;
    }
  }
}

function normalizeCaptchaMode(input = {}) {
  const mode = String(input.captchaMode || "").trim();
  if (mode) return mode;
  if (input.captchaPrompt === false || input.captchaPrompt === "false")
    return "manual_silent";
  return "manual_prompt";
}

function shouldShowCaptchaPrompt(input = {}) {
  return normalizeCaptchaMode(input) !== "manual_silent";
}

function isRealPayPalHost(host = "") {
  return /(?:^|\.)paypal\./i.test(String(host || ""));
}

function formatFetchError(error) {
  const parts = [error?.message || String(error)];
  if (error?.cause?.code) parts.push(error.cause.code);
  if (error?.cause?.message && error.cause.message !== error?.message)
    parts.push(error.cause.message);
  return parts.filter(Boolean).join(" / ");
}

async function readJsonResponse(response) {
  const bodyText = await readResponseText(response);
  try {
    return { data: bodyText ? JSON.parse(bodyText) : {}, bodyText };
  } catch {
    return { data: {}, bodyText };
  }
}

async function readResponseText(response) {
  if (!response.arrayBuffer) return response.text().catch(() => "");
  const bytes = Buffer.from(
    await response.arrayBuffer().catch(() => new ArrayBuffer(0)),
  );
  const encoding = String(
    response.headers?.get?.("content-encoding") || "",
  ).toLowerCase();
  try {
    if (encoding.includes("br"))
      return brotliDecompressSync(bytes).toString("utf8");
    if (encoding.includes("gzip")) return gunzipSync(bytes).toString("utf8");
    if (encoding.includes("deflate"))
      return inflateSync(bytes).toString("utf8");
    if (encoding.includes("zstd"))
      return zstdDecompressSync(bytes).toString("utf8");
  } catch {}
  return bestEffortDecode(bytes);
}

function bestEffortDecode(bytes) {
  const candidates = [
    () => bytes.toString("utf8"),
    () => brotliDecompressSync(bytes).toString("utf8"),
    () => gunzipSync(bytes).toString("utf8"),
    () => inflateSync(bytes).toString("utf8"),
    () => zstdDecompressSync(bytes).toString("utf8"),
  ];
  let best = "";
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    try {
      const text = candidate();
      const score = scoreText(text);
      if (score > bestScore) {
        best = text;
        bestScore = score;
      }
    } catch {}
  }
  return best;
}

function scoreText(text) {
  if (!text) return 0;
  let score = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === "�") score -= 10;
    else if (code === 9 || code === 10 || code === 13) score += 1;
    else if (code >= 32 && code <= 126) score += 2;
    else if (code >= 0x4e00 && code <= 0x9fff) score += 2;
    else if (code < 32) score -= 3;
    else score += 1;
  }
  return score / text.length;
}

function isRecoverableNavigationError(error) {
  return /navigated|closed|context.*destroyed|Cannot find context|Execution context|Promise was collected/i.test(
    error?.message || String(error),
  );
}

function extractCheckoutSessionId(checkoutUrl) {
  const match = String(checkoutUrl || "").match(/\b(cs_[A-Za-z0-9_]+)/);
  return match ? match[1] : "";
}

export class JobStore {
  constructor() {
    this.jobs = new Map();
    this.nextId = 1;
  }

  create(input) {
    const job = new AutoPlusJob(String(this.nextId++), input);
    this.jobs.set(job.id, job);
    queueMicrotask(() => {
      job.run().catch(() => {});
    });
    return job;
  }

  get(id) {
    return this.jobs.get(String(id || ""));
  }

  list() {
    return Array.from(this.jobs.values())
      .map((job) => job.snapshot())
      .reverse();
  }
}
