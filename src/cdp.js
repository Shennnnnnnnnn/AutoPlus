import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sleep } from "./utils.js";

function candidateChromePaths() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium",
  ].filter(Boolean);
}

export class CdpBrowser {
  constructor(options = {}) {
    this.options = options;
    this.port = options.port || 9222 + Math.floor(Math.random() * 1000);
    this.proc = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.contexts = new Map();
  }

  async start() {
    if (this.options.connectOnly) {
      const version = await this.waitForJson("/json/version", 5000);
      this.ws = new WebSocket(version.webSocketDebuggerUrl);
      this.ws.addEventListener("message", (event) => this.onMessage(event));
      await new Promise((resolve, reject) => {
        this.ws.addEventListener("open", resolve, { once: true });
        this.ws.addEventListener("error", reject, { once: true });
      });
      await this.send("Target.setDiscoverTargets", { discover: true });
      const target = await this.send("Target.createTarget", { url: "about:blank" });
      const attached = await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, null);
      this.sessionId = attached.sessionId;
      return this;
    }

    const userDataDir = this.options.userDataDir || await mkdtemp(path.join(tmpdir(), "autoplus-chrome-"));
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      "--disable-features=Translate",
      "about:blank",
    ];
    if (this.options.headless) args.unshift("--headless=new");
    let lastError = null;
    for (const chromePath of [this.options.chromePath, ...candidateChromePaths()].filter(Boolean)) {
      try {
        this.proc = spawn(chromePath, args, { stdio: "ignore" });
        this.proc.on("exit", () => {
          this.proc = null;
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!this.proc) throw lastError || new Error("未找到 Chrome，请设置 CHROME_PATH。");

    const version = await this.waitForJson("/json/version", 20000);
    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    await this.send("Target.setDiscoverTargets", { discover: true });
    const target = await this.send("Target.createTarget", { url: "about:blank" });
    const attached = await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, null);
    this.sessionId = attached.sessionId;
    return this;
  }

  onMessage(event) {
    const payload = JSON.parse(event.data);
    if (payload.method === "Target.attachedToTarget") {
      this.sessionId = payload.params.sessionId;
    }
    if (payload.method === "Runtime.executionContextCreated") {
      const ctx = payload.params.context;
      this.contexts.set(ctx.id, ctx);
    }
    if (payload.method === "Runtime.executionContextDestroyed") {
      this.contexts.delete(payload.params.executionContextId);
    }
    if (payload.method === "Runtime.executionContextsCleared") {
      this.contexts.clear();
    }
    if (!payload.id) return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    this.pending.delete(payload.id);
    if (payload.error) pending.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    else pending.resolve(payload.result || {});
  }

  async waitForJson(endpoint, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}${endpoint}`);
        if (response.ok) return response.json();
      } catch (error) {
        lastError = error;
      }
      await sleep(200);
    }
    throw lastError || new Error("等待 Chrome DevTools 端口超时。");
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  async enablePage() {
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    await this.send("Network.enable");
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
  }

  findContextIdByOrigin(originPart) {
    for (const [id, ctx] of this.contexts.entries()) {
      if (ctx.origin && ctx.origin.includes(originPart)) {
        return id;
      }
    }
    return null;
  }

  async eval(expression, awaitPromise = true, contextId = undefined) {
    const options = {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    };
    if (contextId !== undefined) {
      options.contextId = contextId;
    }
    const result = await this.send("Runtime.evaluate", options);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "页面脚本执行失败。");
    }
    return result.result?.value;
  }

  async setCookie(cookie) {
    await this.send("Network.setCookie", cookie);
  }

  async close() {
    try {
      this.ws?.close();
    } catch {}
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}
