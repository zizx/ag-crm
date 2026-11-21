const DEFAULT_CRM_URL = "http://127.0.0.1:3210";

const crmUrlInput = document.querySelector("#crmUrl");
const statusPill = document.querySelector("#statusPill");
const message = document.querySelector("#message");
const siteEnableStatus = document.querySelector("#siteEnableStatus");
const toggleSiteEnableButton = document.querySelector("#toggleSiteEnable");
const aiExtractPageButton = document.querySelector("#aiExtractPage");

function setStatus(text, type = "") {
  statusPill.textContent = text;
  statusPill.className = type;
}

function setMessage(text, type = "") {
  message.textContent = text || "";
  message.style.color = type === "error" ? "#ba2f2f" : "";
}

async function readActiveTabHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return "";
  try {
    return AG_CRM_SITE.normalizeHost(new URL(tab.url).hostname);
  } catch {
    return "";
  }
}

async function updateSiteEnableUi() {
  const host = await readActiveTabHost();
  if (!host || host === "127.0.0.1" || host === "localhost") {
    siteEnableStatus.textContent = "Open a website tab to enable capture there.";
    siteEnableStatus.className = "tab-hint";
    toggleSiteEnableButton.disabled = true;
    toggleSiteEnableButton.textContent = "Enable on this site";
    return;
  }
  toggleSiteEnableButton.disabled = false;
  const enabled = await AG_CRM_SITE.isEnabled(host);
  if (enabled) {
    siteEnableStatus.textContent = `Capture enabled on ${host}. The Save button will appear on this site.`;
    siteEnableStatus.className = "tab-hint ok";
    toggleSiteEnableButton.textContent = `Disable on ${host}`;
  } else {
    siteEnableStatus.textContent = `Capture is off on ${host}. Enable once — AG CRM will remember this site.`;
    siteEnableStatus.className = "tab-hint";
    toggleSiteEnableButton.textContent = `Enable on ${host}`;
  }
}

async function toggleSiteEnable() {
  const host = await readActiveTabHost();
  if (!host) return;
  const enabled = await AG_CRM_SITE.toggle(host);
  await updateSiteEnableUi();
  setMessage(enabled ? `Enabled capture on ${host}.` : `Disabled capture on ${host}.`);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "ag-crm:refresh-host-gate" }).catch(() => {});
}

async function storageGet(defaults) {
  return chrome.storage.local.get(defaults);
}

async function storageSet(values) {
  return chrome.storage.local.set(values);
}

async function runAiExtractOnPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
    throw new Error("Open a normal web page first, then try again.");
  }
  const host = await readActiveTabHost();
  if (!host) throw new Error("Could not detect the current site.");
  if (!(await AG_CRM_SITE.isEnabled(host))) {
    throw new Error(`Enable capture on ${host} using the button above, then try AI extraction again.`);
  }

  const response = await chrome.runtime.sendMessage({ type: "ag-crm:run-ai-extract-tab", tabId: tab.id });
  if (!response?.ok) {
    throw new Error(response.error || "Could not start AI extraction on this page.");
  }
  setMessage("AI extraction started — look for the blue banner at the top of the page.");
  window.close();
}

async function init() {
  const settings = await storageGet({ crmUrl: DEFAULT_CRM_URL });
  crmUrlInput.value = settings.crmUrl;
  await updateSiteEnableUi();
  setStatus("Ready", "ok");
  setMessage("Enable a site once, then use Save or AI extraction on that site.");
}

toggleSiteEnableButton.addEventListener("click", () =>
  toggleSiteEnable().catch((error) => setMessage(error.message, "error"))
);
crmUrlInput.addEventListener("change", () => {
  const crmUrl = crmUrlInput.value.trim();
  storageSet({ crmUrl });
});
aiExtractPageButton?.addEventListener("click", () =>
  runAiExtractOnPage().catch((error) => setMessage(error.message, "error"))
);

init();
