import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "./config.js";
import { JobStore } from "./automation.js";
import {
  convertAuthSessionToCodexSession,
  extractAccessToken,
  normalizeCheckoutUrl,
  selectSessionInput,
} from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const jobs = new JobStore();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("请求体过大。");
  }
  return body ? JSON.parse(body) : {};
}

async function sendStatic(res, fileName, contentType) {
  const body = await readFile(path.join(publicDir, fileName));
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/") {
      return sendStatic(res, "index.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      return sendStatic(res, "app.js", "text/javascript; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/style.css") {
      return sendStatic(res, "style.css", "text/css; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, {
        smsUrl: DEFAULTS.smsUrl,
        phone: DEFAULTS.phone,
        cardNumber: DEFAULTS.cardNumber,
        cardExpiry: DEFAULTS.cardExpiry,
        cardCvv: DEFAULTS.cardCvv,
        cdpPort: DEFAULTS.cdpPort || "",
        headless: DEFAULTS.headless,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      return sendJson(res, 200, { jobs: jobs.list() });
    }
    if (req.method === "POST" && url.pathname === "/api/convert-session") {
      const input = await readJson(req);
      const converted = convertAuthSessionToCodexSession(selectSessionInput(input.gptSession, input.sessionToken));
      return sendJson(res, 200, { session: converted });
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const input = await readJson(req);
      const checkoutUrl = String(input.checkoutUrl || input.payOpenAiUrl || "").trim();
      if (checkoutUrl) {
        try {
          normalizeCheckoutUrl(checkoutUrl);
        } catch (error) {
          return sendJson(res, 400, { error: error?.message || "Checkout 链接无效。" });
        }
      } else {
        try {
          extractAccessToken(selectSessionInput(input.gptSession, input.sessionToken));
        } catch (error) {
          return sendJson(res, 400, { error: error?.message || "GPT session 内容无效。" });
        }
      }
      const job = jobs.create(input);
      return sendJson(res, 201, job.snapshot());
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: "任务不存在。" });
      return sendJson(res, 200, job.snapshot());
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error?.message || String(error) });
  }
});

server.listen(DEFAULTS.port, DEFAULTS.host, () => {
  console.log(`AutoPlus listening on http://${DEFAULTS.host}:${DEFAULTS.port}`);
});
