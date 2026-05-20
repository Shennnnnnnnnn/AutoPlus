import { ProxyAgent } from "undici";

export function createProxyAwareFetch({
  env = process.env,
  fetchImpl = globalThis.fetch,
  ProxyAgentImpl = ProxyAgent,
} = {}) {
  const agents = new Map();
  return async function proxyAwareFetch(url, options = {}) {
    const proxyUrl = selectProxyUrl(url, env);
    if (!proxyUrl) return fetchImpl(url, options);
    let dispatcher = agents.get(proxyUrl);
    if (!dispatcher) {
      dispatcher = new ProxyAgentImpl(proxyUrl);
      agents.set(proxyUrl, dispatcher);
    }
    return fetchImpl(url, { ...options, dispatcher });
  };
}

function selectProxyUrl(url, env) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (shouldBypassProxy(parsed.hostname, env.NO_PROXY || env.no_proxy || "")) return "";
  if (parsed.protocol === "https:") return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || "";
  if (parsed.protocol === "http:") return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || "";
  return "";
}

function shouldBypassProxy(hostname, noProxy) {
  const host = String(hostname || "").toLowerCase();
  return String(noProxy || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === "*" || host === entry || (entry.startsWith(".") && host.endsWith(entry)));
}
