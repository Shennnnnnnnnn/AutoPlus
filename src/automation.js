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
  // 💡 确保你在 page-scripts.js 中也导出了这些新编写的表达式
  switchToAudioExpression,
  extractAudioUrlExpression,
  fillAudioDigitsExpression
} from "./page-scripts.js";

// 💡 补充火山引擎录音文件识别的常量配置
const VOLC_APP_ID = "1355349884";
const VOLC_TOKEN = "UEVjPvFyT8TLpf8ILyTvhHtbMKAMxyRD";
const VOLC_CLUSTER = "volc_stt_captcha"; 
const VOLC_SUBMIT_ENDPOINT = "https://openspeech.bytedance.com/api/v1/auc/submit";
const VOLC_QUERY_ENDPOINT = "https://openspeech.bytedance.com/api/v1/auc/query";

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

  pause() {
    if (this.status !== "running") return;
    this.status = "paused";
    this.log("任务已被用户手动暂停。", "warn");
  }

  resume() {
    if (this.status !== "paused") return;
    this.status = "running";
    this.log("任务已被手动恢复，正在继续执行...", "ok");
  }

  async stop() {
    if (this.status !== "running" && this.status !== "paused") return;
    this.status = "stopped";
    this.log("任务已被用户手动停止。", "warn");
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
  }

  async checkPauseAndStop() {
    if (this.status === "stopped") {
      throw new Error("任务被手动停止。");
    }
    while (this.status === "paused") {
      await this.sleep(500); // 挂起时每 500ms 检查一次状态
      if (this.status === "stopped") {
        throw new Error("任务被手动停止。");
      }
    }
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

    // 尝试解析 gptSession 提取真实的 GPT 邮箱
    let gptEmail = "";
    try {
      const sessionObj = JSON.parse(this.input.gptSession || "{}");
      gptEmail = sessionObj?.user?.email || "";
    } catch {}

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
      this.result = { checkout, gptEmail };
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
      if (this.status === "stopped") {
        this.error = "任务已被手动停止。";
        this.updatedAt = new Date().toISOString();
        return;
      }
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
    let submittedHostedCheckout = false;
    while (Date.now() < deadline) {
      await this.checkPauseAndStop();
      await this.waitForPageReady(45000).catch(() => {});
      await this.checkPauseAndStop();
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

      // 🔥 关键修改点：拦截并处理 DataDome 验证码
      if (state.hasCaptcha) {
        const captchaMode = normalizeCaptchaMode(this.input);
        
        // 1. 如果是自动绕过模式 (auto)，执行火山语音识别解法
        if (captchaMode === "auto") {
          this.log("检测到 DataDome 验证码，已启动【火山引擎语音识别】全自动绕过方案...", "warn");
          
          const appId = String(this.input.volcAppId || VOLC_APP_ID).trim();
          const token = String(this.input.volcToken || VOLC_TOKEN).trim();

          try {
            // 💡 等待并定位属于 DataDome 的 iframe 的 executionContextId
            let contextId = null;
            const searchDeadline = Date.now() + 5000; // 最多等 5 秒让 context 创建
            while (Date.now() < searchDeadline) {
              if (this.browser.findContextIdByOrigin) {
                contextId = this.browser.findContextIdByOrigin("ddc.paypal.com");
              }
              if (contextId) break;
              await this.sleep(250);
              await this.checkPauseAndStop();
            }
            if (!contextId) {
              throw new Error("未能定位到有效的 DataDome 验证码 iframe 执行上下文。");
            }
            this.log(`成功定位验证码 iframe 执行上下文（ContextID: ${contextId}）。`);

            // A. 驱动前端切换到音频验证码模式
            this.log("正在控制浏览器切换至音频验证组件...");
            await this.evalDuringNavigation(switchToAudioExpression(), contextId);
            await this.sleep(1500); // 等待 DOM 渲染和音频流加载
            await this.checkPauseAndStop();

            // B. 提取前端产生的 wav 真实下载源
            const audioUrl = await this.browser.eval(extractAudioUrlExpression(), true, contextId);
            if (!audioUrl || !audioUrl.startsWith("http")) {
              throw new Error("未能从当前页面截获到有效的音频验证码 URL 轨道。");
            }
            this.log(`成功提取验证码音频链接，准备提交至火山转写系统。`);

            // C. 投递任务到火山引擎异步处理网关
            const submitPayload = {
              app: { appid: appId, token: token, cluster: VOLC_CLUSTER },
              user: { uid: `job_${this.id}_${Date.now()}` },
              audio: { format: "wav", url: audioUrl },
              additions: { use_itn: "True", use_punc: "False" } // 开启数字归一
            };

            const submitResponse = await this.fetch(VOLC_SUBMIT_ENDPOINT, {
              method: "POST",
              headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer; ${token}`
              },
              body: JSON.stringify(submitPayload)
            });
            
            const submitResult = await submitResponse.json().catch(() => ({}));
            if (!submitResponse.ok || submitResult?.resp?.code !== 1000) {
              throw new Error(`火山引擎任务提交拒绝: ${submitResult?.resp?.message || '网络异常'}`);
            }

            const taskId = submitResult.resp.id;
            this.log(`火山任务创建成功(ID: ${taskId})，进入结果回查队列...`);

            // D. 轮询火山转写 service 状态
            let captchaDigits = "";
            const queryPayload = { appid: appId, token: token, cluster: VOLC_CLUSTER, id: taskId };
            const queryDeadline = Date.now() + 20000; // 最多给语音服务 20 秒处理时间
            
            while (Date.now() < queryDeadline) {
              await this.checkPauseAndStop();
              await this.sleep(2000); // 遵循文档每 2 秒查一次
              await this.checkPauseAndStop();
              const queryResponse = await this.fetch(VOLC_QUERY_ENDPOINT, {
                method: "POST",
                headers: { 
                  "Content-Type": "application/json",
                  "Authorization": `Bearer; ${token}`
                },
                body: JSON.stringify(queryPayload)
              });
              
              const queryResult = await queryResponse.json().catch(() => ({}));
              const taskCode = queryResult?.resp?.code;
              
              if (taskCode === 1000) { // 1000 标识识别成功结束
                const rawText = queryResult.resp.text || "";
                captchaDigits = rawText.replace(/\D/g, ""); // 清除空格、汉字，保留纯数字
                break;
              } else if (taskCode < 2000) { // 小于 2000 代表明确的失败状态码
                throw new Error(`火山服务端识别终止: ${queryResult?.resp?.message}`);
              }
              // 大于等于 2000 属于正在处理或排队，继续循环
            }

            if (captchaDigits.length !== 6) {
              throw new Error("火山语音未能在有效时间内解析出标准的 6 位数字验证码。");
            }

            // E. 将识别出的 6 位数字反向流式注入回浏览器表单并点按提交
            this.log(`豆包模型识别成功，密码解出: ${captchaDigits}。正在下发按键流...`, "ok");
            await this.evalDuringNavigation(fillAudioDigitsExpression(captchaDigits), contextId);
            
            this.log("自动提交完毕，等待风控网关放行页面...");
            await this.sleep(3000);
            await this.checkPauseAndStop();
            continue;

          } catch (audioError) {
            this.log(`火山语音全自动过码战术失败: ${audioError.message}，正在无缝降级为人工接管。`, "error");
            // 发生错误时，故意不退出，让它顺延进入下方的人工提示逻辑
          }
        }

        // 2. 传统的人工/提示过码模式 (manual_prompt / manual_silent 附近的原始逻辑)
        if (captchaMode === "test_assume_solved" && !isRealPayPalHost(state.host)) {
          this.log("测试模式：正在自动拖动测试页面滑块。", "warn");
          await this.evalDuringNavigation(testCaptchaSlideExpression());
          await this.sleep(500);
          await this.checkPauseAndStop();
          continue;
        }
        if (lastAction !== "captcha") {
          this.log("检测到 PayPal 验证码，请在浏览器中手动完成验证；验证消失后会自动继续。", "warn");
          lastAction = "captcha";
        }
        if (!captchaPrompted && shouldShowCaptchaPrompt(this.input)) {
          captchaPrompted = true;
          await this.evalDuringNavigation(
            captchaPromptExpression("AutoPlus 已暂停：请手动完成 PayPal 验证码，完成后流程会自动继续。")
          );
        }
        await this.sleep(3000);
        await this.checkPauseAndStop();
        continue;
      }

      if (state.verificationInputs >= 6) {
        this.log("检测到验证码输入框，开始轮询短信验证码。");
        const code = await this.pollSmsCode();
        await this.checkPauseAndStop();
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

  async evalDuringNavigation(expression, contextId = undefined) {
    try {
      return await this.browser.eval(expression, true, contextId);
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
