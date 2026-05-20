import test from "node:test";
import assert from "node:assert/strict";
import { createProxyAwareFetch } from "../src/proxy-fetch.js";

test("createProxyAwareFetch adds a dispatcher for proxied https requests", async () => {
  const calls = [];
  const agents = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true };
  };
  class FakeProxyAgent {
    constructor(proxyUrl) {
      this.proxyUrl = proxyUrl;
      agents.push(this);
    }
  }

  const fetch = createProxyAwareFetch({
    env: {
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1",
    },
    fetchImpl,
    ProxyAgentImpl: FakeProxyAgent,
  });

  await fetch("https://chatgpt.com/backend-api/payments/checkout", { method: "POST" });

  assert.equal(agents.length, 1);
  assert.equal(agents[0].proxyUrl, "http://127.0.0.1:7897");
  assert.equal(calls[0].options.dispatcher, agents[0]);
});

test("createProxyAwareFetch skips the dispatcher for no_proxy hosts", async () => {
  const calls = [];
  const fetch = createProxyAwareFetch({
    env: {
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1",
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true };
    },
    ProxyAgentImpl: class {},
  });

  await fetch("http://127.0.0.1:3217/api/jobs");

  assert.equal(calls[0].options.dispatcher, undefined);
});
