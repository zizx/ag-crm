importScripts("shared/crm-api.js");

const PAGE_SCRIPT_FILES = [
  "shared/crm-api.js",
  "shared/site-settings.js",
  "shared/adapters.js",
  "extract-lead.js",
  "content-script.js"
];

async function ensurePageScripts(tabId) {
  if (!tabId) throw new Error("No tab id for script injection.");
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["page-ui.css"]
  }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId },
    files: PAGE_SCRIPT_FILES
  });
}

async function runAiExtractOnTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || "")) {
    throw new Error("Open a normal web page first, then try again.");
  }
  await ensurePageScripts(tabId);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      if (typeof window.__agCrmRunAiExtract !== "function") {
        return { ok: false, error: "AG CRM did not initialize on this page. Reload the tab and try again." };
      }
      window.__agCrmRunAiExtract({ fromPopup: true });
      return { ok: true, started: true };
    }
  });
  return result || { ok: false, error: "AG CRM could not start AI extraction on this tab." };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "ag-crm:run-ai-extract-tab") {
      try {
        const tabId = message.tabId || sender.tab?.id;
        const result = await runAiExtractOnTab(tabId);
        sendResponse(result);
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (message.type === "ag-crm:ensure-page-scripts") {
      const tabId = message.tabId || sender.tab?.id;
      await ensurePageScripts(tabId);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "ag-crm:api-fetch") {
      const crmUrl = await AG_CRM_API.getCrmUrl();
      const path = String(message.path || "");
      const url = path.startsWith("http") ? path : `${crmUrl}${path.startsWith("/") ? path : `/${path}`}`;
      try {
        const options = message.options || {};
        const response = await fetch(url, options);
        const text = await response.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { raw: text };
        }
        sendResponse({
          ok: response.ok,
          status: response.status,
          body,
          error: body.error || ""
        });
      } catch (error) {
        sendResponse({
          ok: false,
          status: 0,
          body: {},
          networkError: error.message,
          error: error.message
        });
      }
      return;
    }

    if (message.type === "ag-crm:reveal-active-tab") {
      const tabId = sender.tab?.id || message.tabId;
      if (!tabId) throw new Error("No active tab for reveal.");
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["reveal.js"]
      });
      sendResponse(injection?.result || {});
    }
  })().catch((error) => {
    sendResponse({ error: error.message });
  });
  return true;
});
