import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { exec } from "node:child_process";
import crypto from "node:crypto";
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

const ADDRESS_ENDPOINT = "https://www.meiguodizhi.com/api/v1/dz";

export class AutoPlusJob {
  constructor(id, input = {}, dependencies = {}) {
    this.id = id;
    this.input = input;
    this.Browser = dependencies.Browser || CdpBrowser;
    this.fetch = dependencies.fetch || createProxyAwareFetch();
    this.sleep = dependencies.sleep || sleep;
    this.exec = dependencies.exec || exec;
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
    } finally {
      // 若没有使用无头模式执行，在执行失败、成功或手动停止时关闭新打开的 Chrome 浏览器
      const isHeadless = Boolean(this.input.headless ?? DEFAULTS.headless);
      if (!isHeadless && this.browser) {
        await this.browser.close().catch(() => {});
      }
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
        
        // 1. 如果是自动绕过模式 (auto)，执行本地语音识别方案
        if (captchaMode === "auto") {
          this.log("检测到音频组件，已启动【本地语音提取】全自动处理方案...", "warn");
          
          let tempWavPath = "";
          try {
            // 定位属于音频验证的 iframe 执行上下文
            let contextId = null;
            const searchDeadline = Date.now() + 5000;
            while (Date.now() < searchDeadline) {
              if (this.browser.findContextIdByOrigin) {
                contextId = this.browser.findContextIdByOrigin("ddc.paypal.com");
              }
              if (contextId) break;
              await this.sleep(250);
              await this.checkPauseAndStop();
            }
            if (!contextId) {
              throw new Error("未能定位到有效的音频提取执行上下文。");
            }
            this.log(`成功定位执行上下文（ContextID: ${contextId}）。`);

            // 驱动前端切换到音频验证模式
            this.log("正在控制浏览器切换至音频组件...");
            await this.evalDuringNavigation(switchToAudioExpression(), contextId);
            await this.sleep(1500);
            await this.checkPauseAndStop();

            // 提取前端产生的音频真实下载源
            const audioUrl = await this.browser.eval(extractAudioUrlExpression(), true, contextId);
            if (!audioUrl || !audioUrl.startsWith("http")) {
              throw new Error("未能从当前页面截获到有效的音频链接。");
            }
            this.log(`成功提取音频链接，准备下载到本地进行识别。`);

            // 下载音频并保存至 /tmp 临时目录以方便排查与分析
            const audioRes = await this.fetch(audioUrl);
            if (!audioRes.ok) {
              throw new Error(`音频文件下载失败，HTTP 状态码: ${audioRes.status}`);
            }
            const buffer = Buffer.from(await audioRes.arrayBuffer());
            const tempDir = "/tmp";
            tempWavPath = path.join(tempDir, `audio_${crypto.randomBytes(8).toString("hex")}.wav`);
            await fs.promises.writeFile(tempWavPath, buffer);
            this.log("音频下载成功，启动本地语音识别分析...");

            // 从用户输入动态读取 Whisper 执行路径，若未填则默认为全局系统指令
            const whisperPath = String(this.input.whisperPath || "").trim() || "whisper";
            const whisperCmd = `"${whisperPath}" "${tempWavPath}" --language zh --model base --output_dir "${tempDir}"`;

            const execPromise = (cmd) => new Promise((resolve, reject) => {
              this.exec(cmd, (error, stdout, stderr) => {
                if (error) reject(error);
                else resolve(stdout);
              });
            });

            await execPromise(whisperCmd);
            this.log("本地语音分析完成，正在读取转写文本...");

            // 读取转写结果并检索其中的 6 位阿拉伯数字组合（兼容以 .wav.txt 与 .txt 结尾的转写文件名）
            const txtPath1 = tempWavPath + ".txt";
            const txtPath2 = path.join(tempDir, path.basename(tempWavPath, ".wav") + ".txt");
            
            let txtPath = txtPath1;
            try {
              await fs.promises.access(txtPath1);
            } catch {
              txtPath = txtPath2;
            }

            const txtContent = await fs.promises.readFile(txtPath, "utf8");
            
            // 将文本中的中文数字（如：三、九）转换为阿拉伯数字，以支持 Whisper 可能转写出的中文大写数字
            const chineseToDigits = (text) => {
              const map = {
                "零": "0", "〇": "0", "一": "1", "二": "2", "两": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9"
              };
              return text.split("").map(c => map[c] || c).join("");
            };

            const convertedText = chineseToDigits(txtContent);
            // 过滤掉可能存在的各种分隔符和空格（如：顿号、空格、逗号等）
            const cleanedText = convertedText.replace(/[\s,，.。、\-]+/g, "");
            const match = cleanedText.match(/\d{6}/);
            if (!match) {
              // 发生提取错误时，在 Job Log 中详细打印识别的原始文本，并保留文件，绝不“盲猜”
              this.log(`[语音识别调试] 提取验证码失败。原始文本为: "${txtContent.trim()}"，过滤清洁后为: "${cleanedText}"，临时文本路径为: "${txtPath}"`, "error");
              this._keepAudioDebugFiles = true;
              throw new Error("未能从本地语音分析文本中提取到 6 位数字组合。");
            }

            const digits = match[0];
            this.log(`本地识别成功，解出数字: ${digits}。正在下发按键流...`, "ok");
            await this.evalDuringNavigation(fillAudioDigitsExpression(digits), contextId);
            
            this.log("自动提交完毕，等待放行页面...");
            await this.sleep(3000);
            await this.checkPauseAndStop();
            continue;

          } catch (audioError) {
            this.log(`全自动语音提取方案失败: ${audioError.message}，正在无缝降级为人工接管。`, "error");
          } finally {
            if (tempWavPath && !this._keepAudioDebugFiles) {
              try {
                await fs.promises.unlink(tempWavPath);
              } catch {}
              try {
                const tempDir = "/tmp";
                const baseNameWithWav = path.basename(tempWavPath);
                const baseNameWithoutWav = path.basename(tempWavPath, ".wav");
                const exts = [".txt", ".srt", ".vtt", ".tsv", ".json"];
                for (const ext of exts) {
                  await fs.promises.unlink(path.join(tempDir, baseNameWithWav + ext)).catch(() => {});
                  await fs.promises.unlink(path.join(tempDir, baseNameWithoutWav + ext)).catch(() => {});
                }
              } catch {}
            } else if (this._keepAudioDebugFiles) {
              this.log(`[语音识别调试] 提取失败，已专门为您保留该次失败的临时转写文件，音频路径: "${tempWavPath}"`, "warn");
              this._keepAudioDebugFiles = false; // 重置标志
            }
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
          this.log("检测到安全验证，请在浏览器中手动完成；验证消失后会自动继续。", "warn");
          lastAction = "captcha";
        }
        if (!captchaPrompted && shouldShowCaptchaPrompt(this.input)) {
          captchaPrompted = true;
          await this.evalDuringNavigation(
            captchaPromptExpression("AutoPlus 已暂停：请手动完成验证，完成后流程会自动继续。")
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
