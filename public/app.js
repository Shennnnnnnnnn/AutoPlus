const form = document.getElementById("job-form");
const convertForm = document.getElementById("convert-form");
const convertOutput = document.getElementById("convert-output");
const jobsEl = document.getElementById("jobs");
const historyEl = document.getElementById("success-history");
const refresh = document.getElementById("refresh");
const clearHistory = document.getElementById("clear-history");
const SUCCESS_HISTORY_KEY = "autoplus.successHistory.v1";
const FORM_CACHE_KEY = "autoplus.formCache.v1";
const CACHEABLE_FIELDS = [
  "smsUrl",
  "phone",
  "cardNumber",
  "cardExpiry",
  "cardCvv",
  "chromePath",
  "cdpPort",
  "captchaMode",
  "headless",
];

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function loadConfig() {
  const config = await json("/api/config");
  for (const [key, value] of Object.entries(config)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value || "";
  }
  restoreFormCache();
}

function readFormCache() {
  try {
    const value = JSON.parse(localStorage.getItem(FORM_CACHE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeFormCache(data) {
  localStorage.setItem(FORM_CACHE_KEY, JSON.stringify(data));
}

function restoreFormCache() {
  const cache = readFormCache();
  for (const name of CACHEABLE_FIELDS) {
    const field = form.elements[name];
    if (!field || !(name in cache)) continue;
    if (field.type === "checkbox") field.checked = Boolean(cache[name]);
    else field.value = cache[name] || "";
  }
}

function cacheFormValues() {
  const cache = {};
  for (const name of CACHEABLE_FIELDS) {
    const field = form.elements[name];
    if (!field) continue;
    cache[name] = field.type === "checkbox" ? field.checked : field.value;
  }
  writeFormCache(cache);
}

function readSuccessHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(SUCCESS_HISTORY_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeSuccessHistory(records) {
  localStorage.setItem(SUCCESS_HISTORY_KEY, JSON.stringify(records.slice(0, 50)));
}

function successRecordFromJob(job) {
  const profile = job.result?.profile || {};
  const email = String(profile.email || "").trim();
  if (!email) return null;
  return {
    id: email,
    jobId: job.id,
    savedAt: new Date().toISOString(),
    email,
  };
}

function storeSuccessfulJobs(jobs) {
  const next = readSuccessHistory();
  const seen = new Set(next.map((record) => record.id));
  for (const job of jobs || []) {
    if (job.status !== "succeeded") continue;
    const record = successRecordFromJob(job);
    if (!record || seen.has(record.id)) continue;
    next.unshift(record);
    seen.add(record.id);
  }
  writeSuccessHistory(next);
  renderSuccessHistory();
}

function renderSuccessHistory() {
  const records = readSuccessHistory();
  historyEl.innerHTML = records.length ? records.map(renderSuccessRecord).join("") : "<p class='empty'>暂无成功账号</p>";
}

function renderSuccessRecord(record) {
  return `<article class="success-record">
    <div class="record-head"><strong>${escapeHtml(record.email)}</strong><span>${new Date(record.savedAt).toLocaleString()}</span></div>
  </article>`;
}

function renderJob(job) {
  const logs = (job.logs || []).slice(-12).map((entry) => {
    return `<div class="log ${entry.level}"><time>${new Date(entry.at).toLocaleTimeString()}</time><span>${escapeHtml(entry.message)}</span></div>`;
  }).join("");
  const checkout = job.result?.checkout?.preferredCheckoutUrl
    ? `<a href="${job.result.checkout.preferredCheckoutUrl}" target="_blank" rel="noreferrer">checkout</a>`
    : "";
  return `<article class="job ${job.status}">
    <div class="job-head"><strong>#${job.id}</strong><span>${job.status}</span>${checkout}</div>
    ${job.error ? `<p class="error">${escapeHtml(job.error)}</p>` : ""}
    <div class="logs">${logs}</div>
  </article>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

async function loadJobs() {
  const data = await json("/api/jobs");
  jobsEl.innerHTML = data.jobs.length ? data.jobs.map(renderJob).join("") : "<p class='empty'>暂无任务</p>";
  storeSuccessfulJobs(data.jobs);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  data.headless = form.elements.headless.checked;
  cacheFormValues();
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await json("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await loadJobs();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

convertForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(convertForm).entries());
  const button = convertForm.querySelector("button[type=submit]");
  button.disabled = true;
  convertOutput.value = "";
  try {
    const result = await json("/api/convert-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    convertOutput.value = JSON.stringify(result.session, null, 2);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

refresh.addEventListener("click", loadJobs);
clearHistory.addEventListener("click", () => {
  localStorage.removeItem(SUCCESS_HISTORY_KEY);
  renderSuccessHistory();
});
renderSuccessHistory();
loadConfig().then(loadJobs);
setInterval(loadJobs, 3000);
