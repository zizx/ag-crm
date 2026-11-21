(function initAgCrmSiteGate() {
  if (window.__agCrmSiteGateInitialized) return;
  window.__agCrmSiteGateInitialized = true;

  window.__agCrmHostEnabled = false;

  async function refreshHostGate() {
    window.__agCrmHostEnabled = await AG_CRM_SITE.isEnabled(location.hostname);
    const launcher = document.getElementById("ag-crm-launcher");
    if (window.__agCrmHostEnabled) {
      if (launcher) launcher.style.display = "";
      document.dispatchEvent(new CustomEvent("ag-crm:host-enabled"));
      return;
    }
    if (launcher) launcher.style.display = "none";
  }

  window.AG_CRM_refreshHostGate = refreshHostGate;
  window.AG_CRM_isHostEnabled = () => Boolean(window.__agCrmHostEnabled);

  refreshHostGate();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.enabledCaptureHosts) refreshHostGate();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "ag-crm:refresh-host-gate") refreshHostGate();
  });
})();

(function initAgCrmPageUi() {
  if (window.__agCrmPageUiInitialized) return;

  const ROOT_ID = "ag-crm-launcher";

  const state = {
    open: false,
    lead: null,
    match: null,
    busy: false,
    toastTimer: null
  };

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const openBtn = document.createElement("button");
  openBtn.id = "ag-crm-open-btn";
  openBtn.type = "button";
  openBtn.innerHTML = '<span class="dot"></span><span>Save to AG CRM</span>';

  const panel = document.createElement("section");
  panel.id = "ag-crm-panel";
  panel.className = "hidden";
  panel.innerHTML = `
    <div class="panel-inner">
      <div class="panel-header">
        <div>
          <h2>AG CRM Lead Capture</h2>
          <p id="ag-crm-page-kind">Scanning page…</p>
        </div>
        <button class="icon-btn" type="button" id="ag-crm-close" aria-label="Close">✕</button>
      </div>
      <div id="ag-crm-banner" class="banner hidden"></div>
      <label>Name<input id="ag-crm-name" /></label>
      <label>Company<input id="ag-crm-company" /></label>
      <label>Title<input id="ag-crm-title" /></label>
      <label>Email<input id="ag-crm-email" /></label>
      <label>Phone<input id="ag-crm-phone" /></label>
      <label>Website<input id="ag-crm-website" /></label>
      <label>Address<input id="ag-crm-address" /></label>
      <label>Note<textarea id="ag-crm-note"></textarea></label>
      <div class="actions">
        <button class="secondary" type="button" id="ag-crm-reveal">Reveal & Rescan</button>
        <button class="primary" type="button" id="ag-crm-save">Save to CRM</button>
      </div>
      <button class="secondary ai-extract-btn" type="button" id="ag-crm-ai-extract">✨ Get all leads (AI)</button>
      <div id="ag-crm-ai-results" class="ai-results hidden">
        <div class="ai-results-header">
          <strong id="ag-crm-ai-count">0 leads</strong>
          <label class="ai-select-all"><input type="checkbox" id="ag-crm-ai-select-all" checked /> Select all</label>
        </div>
        <p class="ai-engine-note" id="ag-crm-ai-engine"></p>
        <div id="ag-crm-ai-list" class="ai-list"></div>
        <button class="primary" type="button" id="ag-crm-ai-save">Save selected to CRM</button>
        <button class="link-like" type="button" id="ag-crm-ai-rescan">Results wrong? Re-scan with AI</button>
      </div>
      <div class="status" id="ag-crm-status"></div>
    </div>
  `;

  root.append(openBtn, panel);
  document.documentElement.append(root);

  const toast = document.createElement("aside");
  toast.id = "ag-crm-capture-toast";
  toast.className = "hidden";
  toast.innerHTML = `
    <div class="toast-inner">
      <div class="toast-header">
        <div>
          <p class="toast-eyebrow" id="ag-crm-toast-eyebrow">AG CRM</p>
          <strong id="ag-crm-toast-title">Saved contact</strong>
        </div>
        <button class="icon-btn" type="button" id="ag-crm-toast-close" aria-label="Dismiss">✕</button>
      </div>
      <p class="toast-summary" id="ag-crm-toast-summary"></p>
      <div class="toast-fields" id="ag-crm-toast-fields"></div>
      <div class="toast-actions" id="ag-crm-toast-actions">
        <button class="secondary" type="button" data-action="undo">Undo</button>
        <button class="secondary" type="button" data-action="flag">Flag</button>
        <button class="primary" type="button" data-action="edit">Edit</button>
      </div>
      <p class="toast-hint" id="ag-crm-toast-hint">Saved automatically. Dismisses in a few seconds.</p>
    </div>
  `;
  document.documentElement.append(toast);

  const toastEls = {
    eyebrow: toast.querySelector("#ag-crm-toast-eyebrow"),
    title: toast.querySelector("#ag-crm-toast-title"),
    summary: toast.querySelector("#ag-crm-toast-summary"),
    fields: toast.querySelector("#ag-crm-toast-fields"),
    actions: toast.querySelector("#ag-crm-toast-actions"),
    hint: toast.querySelector("#ag-crm-toast-hint"),
    close: toast.querySelector("#ag-crm-toast-close")
  };

  const toastState = {
    contactId: "",
    saveStatus: "",
    lead: null
  };

  const els = {
    pageKind: panel.querySelector("#ag-crm-page-kind"),
    banner: panel.querySelector("#ag-crm-banner"),
    status: panel.querySelector("#ag-crm-status"),
    name: panel.querySelector("#ag-crm-name"),
    company: panel.querySelector("#ag-crm-company"),
    title: panel.querySelector("#ag-crm-title"),
    email: panel.querySelector("#ag-crm-email"),
    phone: panel.querySelector("#ag-crm-phone"),
    website: panel.querySelector("#ag-crm-website"),
    address: panel.querySelector("#ag-crm-address"),
    note: panel.querySelector("#ag-crm-note"),
    save: panel.querySelector("#ag-crm-save"),
    reveal: panel.querySelector("#ag-crm-reveal"),
    aiExtract: panel.querySelector("#ag-crm-ai-extract"),
    aiResults: panel.querySelector("#ag-crm-ai-results"),
    aiCount: panel.querySelector("#ag-crm-ai-count"),
    aiSelectAll: panel.querySelector("#ag-crm-ai-select-all"),
    aiList: panel.querySelector("#ag-crm-ai-list"),
    aiSave: panel.querySelector("#ag-crm-ai-save"),
    aiEngine: panel.querySelector("#ag-crm-ai-engine"),
    aiRescan: panel.querySelector("#ag-crm-ai-rescan")
  };

  function formatLeadSummary(lead) {
    return [lead.name, lead.company_name].filter(Boolean).join(" · ") || "Contact captured";
  }

  function formatLeadFields(lead) {
    const rows = [
      ["Title", lead.title],
      ["Email", (lead.emails || []).join(", ")],
      ["Phone", (lead.phones || []).join(", ")],
      ["Company", lead.company_name]
    ].filter(([, value]) => String(value || "").trim());
    if (!rows.length) return "";
    return rows
      .map(([label, value]) => `<div class="toast-field"><span>${label}</span><span>${escapeHtml(value)}</span></div>`)
      .join("");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clearToastTimer() {
    if (state.toastTimer) {
      window.clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
  }

  function hideCaptureToast() {
    clearToastTimer();
    toast.classList.add("hidden");
    toast.classList.remove("capturing", "saved", "error", "notice", "duplicate");
  }

  function scheduleToastDismiss(ms = 14000) {
    clearToastTimer();
    state.toastTimer = window.setTimeout(() => hideCaptureToast(), ms);
  }

  function showCaptureToast(options = {}) {
    const phase = options.phase || "saved";
    toast.classList.remove("hidden", "capturing", "saved", "error", "notice", "duplicate");
    toast.classList.add(phase);

    if (phase === "capturing") {
      toastEls.eyebrow.textContent = "AG CRM";
      toastEls.title.textContent = "Scanning profile…";
      toastEls.summary.textContent = "Revealing phone and saving contact.";
      toastEls.fields.innerHTML = "";
      toastEls.actions.style.display = "none";
      toastEls.hint.textContent = "Please wait.";
      clearToastTimer();
      return;
    }

    if (phase === "error") {
      toastEls.eyebrow.textContent = "AG CRM";
      toastEls.title.textContent = "Capture failed";
      toastEls.summary.textContent = options.message || "Could not save this profile.";
      toastEls.fields.innerHTML = "";
      toastEls.actions.style.display = "none";
      toastEls.hint.textContent = "Open the panel to capture manually.";
      scheduleToastDismiss(9000);
      return;
    }

    if (phase === "notice") {
      toastEls.eyebrow.textContent = "AG CRM";
      toastEls.title.textContent = options.title || "Updated";
      toastEls.summary.textContent = options.message || "";
      toastEls.fields.innerHTML = "";
      toastEls.actions.style.display = "none";
      toastEls.hint.textContent = options.hint || "";
      scheduleToastDismiss(options.dismissMs || 5000);
      return;
    }

    if (phase === "duplicate") {
      toastEls.eyebrow.textContent = "Already in CRM";
      toastEls.title.textContent = options.title || "Duplicate skipped";
      toastEls.summary.textContent = options.message || "This profile is already saved.";
      toastEls.fields.innerHTML = options.lead ? formatLeadFields(options.lead) : "";
      toastEls.actions.style.display = "grid";
      toastEls.actions.querySelector('[data-action="undo"]').style.display = "none";
      toastEls.actions.querySelector('[data-action="flag"]').style.display = "inline-flex";
      toastEls.actions.querySelector('[data-action="edit"]').style.display = "inline-flex";
      toastEls.hint.textContent = options.hint || "No changes were saved.";
      toastState.contactId = options.contactId || "";
      toastState.lead = options.lead || null;
      toastState.saveStatus = "skipped";
      scheduleToastDismiss(9000);
      return;
    }

    const lead = options.lead || {};
    toastState.contactId = options.contactId || "";
    toastState.saveStatus = options.saveStatus || "created";
    toastState.lead = lead;

    toastEls.eyebrow.textContent = toastState.saveStatus === "created" ? "Saved to CRM" : "Updated in CRM";
    toastEls.title.textContent = formatLeadSummary(lead);
    toastEls.summary.textContent =
      toastState.saveStatus === "created"
        ? "Contact saved automatically."
        : "Matched an existing contact and refreshed the record.";
    toastEls.fields.innerHTML = formatLeadFields(lead);
    toastEls.actions.style.display = "grid";
    toastEls.actions.querySelector('[data-action="undo"]').style.display =
      toastState.saveStatus === "created" ? "inline-flex" : "none";
    toastEls.actions.querySelector('[data-action="flag"]').style.display = "inline-flex";
    toastEls.actions.querySelector('[data-action="edit"]').style.display = "inline-flex";
    toastEls.hint.textContent =
      toastState.saveStatus === "created"
        ? "Dismisses soon if you do nothing."
        : "Undo is unavailable for updates. Use Edit or Flag.";
    scheduleToastDismiss();
  }

  async function handleToastAction(action) {
    if (!toastState.contactId && action !== "edit") return;
    clearToastTimer();

    if (action === "undo") {
      if (toastState.saveStatus !== "created") {
        showCaptureToast({
          phase: "notice",
          title: "Can't undo update",
          message: "This profile matched an existing CRM contact.",
          hint: "Use Edit to adjust fields."
        });
        return;
      }
      try {
        await AG_CRM_API.deleteContact(toastState.contactId, {
          note: "Undone from capture toast."
        });
        openBtn.querySelector("span:last-child").textContent = "Save to AG CRM";
        showCaptureToast({
          phase: "notice",
          title: "Save undone",
          message: "Contact removed from CRM.",
          hint: "Open this profile again to re-capture."
        });
      } catch (error) {
        showCaptureToast({ phase: "error", message: error.message });
      }
      return;
    }

    if (action === "flag") {
      try {
        await AG_CRM_API.markContactPendingReview(toastState.contactId, {
          note: "Flagged from auto-capture toast."
        });
        showCaptureToast({
          phase: "notice",
          title: "Flagged for review",
          message: "Contact marked as needs review in CRM.",
          hint: "You can confirm it later in the CRM."
        });
      } catch (error) {
        showCaptureToast({ phase: "error", message: error.message });
      }
      return;
    }

    if (action === "edit") {
      if (toastState.lead) {
        state.lead = toastState.lead;
        fillForm(toastState.lead);
      }
      hideCaptureToast();
      openPanel();
    }
  }

  toastEls.close.addEventListener("click", hideCaptureToast);
  toast.addEventListener("mouseenter", clearToastTimer);
  toast.addEventListener("mouseleave", () => {
    if (!toast.classList.contains("hidden") && toast.classList.contains("saved")) {
      scheduleToastDismiss();
    }
  });
  toastEls.actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    handleToastAction(button.dataset.action);
  });

  function setStatus(text) {
    els.status.textContent = text || "";
  }

  function setBanner(text, type = "warn") {
    if (!text) {
      els.banner.className = "banner hidden";
      els.banner.textContent = "";
      return;
    }
    els.banner.className = `banner ${type}`;
    els.banner.textContent = text;
  }

  function showAiActivity(text, type = "info") {
    let node = document.getElementById("ag-crm-ai-activity");
    if (!node) {
      node = document.createElement("div");
      node.id = "ag-crm-ai-activity";
      document.documentElement.appendChild(node);
    }
    if (!text) {
      node.className = "hidden";
      node.textContent = "";
      return;
    }
    node.className = type === "error" ? "error" : "info";
    node.textContent = text;
    console.info("[AG CRM AI]", text);
  }

  function readLeadFromForm() {
    return {
      ...(state.lead || {}),
      name: els.name.value.trim(),
      company_name: els.company.value.trim(),
      title: els.title.value.trim(),
      emails: AG_CRM_API.splitList(els.email.value),
      phones: AG_CRM_API.splitList(els.phone.value),
      website: els.website.value.trim(),
      address: els.address.value.trim(),
      source: state.lead?.source || {
        url: window.location.href,
        domain: window.location.hostname.replace(/^www\./, ""),
        platform: window.location.hostname.replace(/^www\./, ""),
        captured_at: new Date().toISOString()
      }
    };
  }

  function fillForm(lead) {
    els.name.value = lead.name || "";
    els.company.value = lead.company_name || "";
    els.title.value = lead.title || "";
    els.email.value = (lead.emails || []).join(", ");
    els.phone.value = (lead.phones || []).join(", ");
    els.website.value = lead.website || "";
    els.address.value = lead.address || "";
  }

  function formatMatchBanner(matchResult) {
    if (!matchResult?.exists || !matchResult.best_match) return "";
    const contact = matchResult.best_match.contact;
    const reason = matchResult.best_match.match_reason || "This lead already exists in the CRM.";
    const label = contact.name || contact.emails?.[0] || contact.phones?.[0] || "Existing contact";
    const company = contact.company?.name ? ` · ${contact.company.name}` : "";
    return `${reason} Found: ${label}${company}. Saving will update the existing record.`;
  }

  async function scanPage() {
    if (state.busy) return;
    state.busy = true;
    setStatus("Scanning page…");
    try {
      const kind = window.AG_CRM.getPageKind();
      els.pageKind.textContent = kind === "profile" ? "Profile page detected" : "Review extracted fields";

      const lead = await window.AG_CRM.extractLead();
      state.lead = lead;
      fillForm(lead);

      const leadHasIdentity =
        String(lead.name || "").trim() ||
        String(lead.company_name || "").trim() ||
        lead.emails?.length ||
        lead.phones?.length;
      if (!leadHasIdentity) {
        setBanner(
          "Quick scan found no lead on this page. Use ✨ Get all leads (AI) below — it reads the whole page and works on any site.",
          "warn"
        );
        setStatus("");
        return;
      }

      const matchResult = await AG_CRM_API.matchContact(lead);
      state.match = matchResult;
      setBanner(formatMatchBanner(matchResult), matchResult.exists ? "warn" : "ok");
      if (!matchResult.exists && lead.phone_reveal_available) {
        setStatus("Phone may be hidden. Use Reveal & Rescan if needed.");
      } else {
        setStatus(matchResult.exists ? "Duplicate detected." : "Ready to save.");
      }
      openBtn.querySelector("span:last-child").textContent = matchResult.exists ? "AG CRM · Exists" : "Save to AG CRM";
    } catch (error) {
      setBanner(error.message, "error");
      setStatus("");
    } finally {
      state.busy = false;
    }
  }

  async function revealAndRescan() {
    if (state.busy) return;
    state.busy = true;
    els.reveal.disabled = true;
    setStatus("Revealing phone…");
    try {
      const revealResult = await chrome.runtime.sendMessage({ type: "ag-crm:reveal-active-tab" });
      await new Promise((resolve) => setTimeout(resolve, revealResult?.clicked ? 1200 : 400));
      const lead = await window.AG_CRM.extractLead();
      state.lead = lead;
      fillForm(lead);
      const matchResult = await AG_CRM_API.matchContact(lead);
      state.match = matchResult;
      setBanner(formatMatchBanner(matchResult), matchResult.exists ? "warn" : "ok");
      setStatus(lead.phones?.length ? "Phone refreshed." : "No full phone became visible.");
    } catch (error) {
      setBanner(error.message, "error");
    } finally {
      els.reveal.disabled = false;
      state.busy = false;
    }
  }

  async function saveLead() {
    if (state.busy) return;
    state.busy = true;
    els.save.disabled = true;
    setStatus("Saving…");
    try {
      const lead = readLeadFromForm();
      const result = await AG_CRM_API.upsertContact(lead, { note: els.note.value.trim() });
      const matchResult = await AG_CRM_API.matchContact(lead);
      state.match = matchResult;
      setBanner(formatMatchBanner(matchResult), "ok");
      setStatus(result.status === "created" ? "Lead created in CRM." : "Existing lead updated in CRM.");
      openBtn.querySelector("span:last-child").textContent = "AG CRM · Saved";
    } catch (error) {
      setBanner(error.message, "error");
      setStatus("");
    } finally {
      els.save.disabled = false;
      state.busy = false;
    }
  }

  const aiState = {
    leads: [],
    busy: false,
    model: "",
    source: "llm"
  };

  const AI_CACHE_PREFIX = "ag-crm-ai-cache:";

  function aiCacheKey() {
    return `${AI_CACHE_PREFIX}${window.location.href.split("#")[0]}`;
  }

  function readAiCache() {
    try {
      const raw = sessionStorage.getItem(aiCacheKey());
      if (!raw) return null;
      const cached = JSON.parse(raw);
      return Array.isArray(cached?.leads) ? cached : null;
    } catch {
      return null;
    }
  }

  function writeAiCache(leads, model, source) {
    try {
      sessionStorage.setItem(aiCacheKey(), JSON.stringify({ leads, model, source, cached_at: Date.now() }));
    } catch {
      // storage full or unavailable — cache is best-effort only
    }
  }

  function pageDomain() {
    return window.location.hostname.replace(/^www\./, "").toLowerCase();
  }

  function leadHasAnyIdentity(lead) {
    return Boolean(
      String(lead?.name || "").trim() ||
        String(lead?.company_name || "").trim() ||
        lead?.emails?.length ||
        lead?.phones?.length
    );
  }

  function setAiEngineNote() {
    if (!els.aiEngine) return;
    if (aiState.source === "recipe") {
      els.aiEngine.textContent = "Extracted with this site's saved recipe — no AI cost.";
      els.aiEngine.className = "ai-engine-note recipe";
    } else {
      els.aiEngine.textContent = `Extracted with AI${aiState.model ? ` (${aiState.model})` : ""}.`;
      els.aiEngine.className = "ai-engine-note";
    }
    if (els.aiRescan) {
      els.aiRescan.style.display = aiState.source === "recipe" ? "" : "none";
    }
  }

  // Recipe self-feedback loop: verify the AI-proposed recipe against the live
  // page and only persist it when it reproduces most of the AI's own results.
  async function validateAndSaveRecipe(recipe, llmLeads, model) {
    if (!recipe) return false;
    let recipeLeads = [];
    try {
      recipeLeads = (window.AG_CRM.runExtractionRecipe(recipe) || []).filter(leadHasAnyIdentity);
    } catch {
      recipeLeads = [];
    }
    const required = Math.max(1, Math.floor((llmLeads.length || 1) * 0.7));
    if (recipeLeads.length < required) {
      console.info("[AG CRM AI] recipe rejected by validation", {
        domain: pageDomain(),
        recipe_leads: recipeLeads.length,
        llm_leads: llmLeads.length,
        required
      });
      AG_CRM_API.logClientDebugEvent({
        kind: "recipe-validation-failed",
        domain: pageDomain(),
        url: window.location.href,
        message: "AI-proposed recipe reproduced too few of the AI's own leads; recipe not saved.",
        detail: {
          recipe,
          recipe_lead_count: recipeLeads.length,
          llm_lead_count: llmLeads.length,
          required_lead_count: required,
          recipe_leads_sample: recipeLeads.slice(0, 3),
          llm_leads_sample: llmLeads.slice(0, 3)
        }
      }).catch(() => {});
      return false;
    }
    try {
      await AG_CRM_API.saveExtractionRecipe({
        domain: pageDomain(),
        recipe,
        model,
        url: window.location.href,
        sample_lead_count: recipeLeads.length
      });
      console.info("[AG CRM AI] recipe saved", { domain: pageDomain(), recipe_leads: recipeLeads.length });
      return true;
    } catch (error) {
      console.warn("[AG CRM AI] recipe save failed", error);
      return false;
    }
  }

  function renderAiLeadRow(lead, index) {
    const meta = [lead.title, lead.emails?.[0], lead.phones?.[0], lead.city]
      .filter(Boolean)
      .join(" · ");
    const kindLabel = lead.record_kind === "company" ? "Company" : "Person";
    const confidence = lead.confidence ? `${Math.round(lead.confidence * 100)}%` : "";
    return `
      <label class="ai-lead" data-index="${index}">
        <input type="checkbox" class="ai-lead-check" data-index="${index}" checked />
        <span class="ai-lead-body">
          <span class="ai-lead-name">${escapeHtml(lead.name || lead.company_name || "(no name)")}</span>
          ${lead.name && lead.company_name ? `<span class="ai-lead-company">${escapeHtml(lead.company_name)}</span>` : ""}
          ${meta ? `<span class="ai-lead-meta">${escapeHtml(meta)}</span>` : ""}
          <span class="ai-lead-badges">${escapeHtml(kindLabel)}${confidence ? ` · ${confidence}` : ""}</span>
          <span class="ai-lead-result" data-result="${index}"></span>
        </span>
      </label>
    `;
  }

  function renderAiLeads() {
    els.aiCount.textContent = `${aiState.leads.length} lead${aiState.leads.length === 1 ? "" : "s"} found`;
    els.aiList.innerHTML = aiState.leads.map((lead, index) => renderAiLeadRow(lead, index)).join("");
    els.aiSelectAll.checked = true;
    els.aiResults.classList.toggle("hidden", !aiState.leads.length);
    els.aiSave.disabled = !aiState.leads.length;
    setAiEngineNote();
  }

  async function extractLeadsWithAi({ skipCache = false, forceLlm = false, fromPopup = false } = {}) {
    if (aiState.busy) {
      showAiActivity("AI extraction is already running on this page…");
      return;
    }
    await window.AG_CRM_refreshHostGate?.();
    if (!window.AG_CRM_isHostEnabled?.()) {
      const msg = "Enable this site in the AG CRM extension popup first.";
      setBanner(msg, "error");
      showAiActivity(msg, "error");
      return;
    }
    root.style.display = "block";
    if (!state.open) openPanel({ skipScan: true });
    aiState.busy = true;
    els.aiExtract.disabled = true;
    els.aiExtract.textContent = "✨ Extracting…";
    setBanner("");
    showAiActivity("✨ Extracting leads with AI — this can take up to a minute on long pages…");
    panel.scrollIntoView({ block: "nearest" });
    AG_CRM_API.logClientDebugEvent({
      kind: "client-event",
      url: window.location.href,
      domain: pageDomain(),
      message: "AI extract started",
      detail: { source: fromPopup ? "popup" : "panel", skip_cache: skipCache, force_llm: forceLlm }
    }).catch(() => {});

    if (!skipCache && !forceLlm) {
      const cached = readAiCache();
      if (cached) {
        aiState.leads = cached.leads;
        aiState.model = cached.model || "";
        aiState.source = cached.source || "llm";
        renderAiLeads();
        setStatus(
          `Showing ${cached.leads.length} lead(s) from this session's earlier scan (no new AI call). Reload the page to re-scan.`
        );
        showAiActivity(`Showing ${cached.leads.length} cached lead(s) from this session — review in the panel.`);
        aiState.busy = false;
        els.aiExtract.disabled = false;
        els.aiExtract.textContent = "✨ Get all leads (AI)";
        return;
      }
    }

    const domain = pageDomain();
    let failedRecipe = null;

    try {
      // Step 1 — free path: run this site's saved recipe if one exists.
      if (!forceLlm) {
        setStatus("Checking for a saved extraction recipe for this site…");
        let recipeRecord = null;
        try {
          recipeRecord = (await AG_CRM_API.getExtractionRecipe(domain))?.recipe || null;
        } catch {
          recipeRecord = null;
        }
        if (recipeRecord?.status === "active" && recipeRecord.recipe) {
          const recipeLeads = (window.AG_CRM.runExtractionRecipe(recipeRecord.recipe) || []).filter(
            leadHasAnyIdentity
          );
          if (recipeLeads.length) {
            aiState.leads = recipeLeads;
            aiState.model = recipeRecord.model || "";
            aiState.source = "recipe";
            writeAiCache(aiState.leads, aiState.model, "recipe");
            renderAiLeads();
            setStatus(
              `${recipeLeads.length} lead(s) via saved recipe — no AI cost. Review and save, or re-scan with AI if results look wrong.`
            );
            showAiActivity(`✓ ${recipeLeads.length} lead(s) via saved recipe — review in the panel.`);
            AG_CRM_API.sendRecipeFeedback({
              domain,
              status: "success",
              lead_count: recipeLeads.length,
              url: window.location.href
            }).catch(() => {});
            console.info("[AG CRM AI] recipe extraction succeeded", { domain, lead_count: recipeLeads.length });
            return;
          }
          // Recipe broke (site changed) — report it and let the LLM repair it below.
          failedRecipe = recipeRecord.recipe;
          AG_CRM_API.sendRecipeFeedback({
            domain,
            status: "failure",
            lead_count: 0,
            url: window.location.href
          }).catch(() => {});
          console.warn("[AG CRM AI] saved recipe produced no leads, falling back to AI", { domain });
        }
      } else if (readAiCache()?.source === "recipe") {
        // User asked for an AI re-scan because recipe output looked wrong.
        try {
          failedRecipe = (await AG_CRM_API.getExtractionRecipe(domain))?.recipe?.recipe || null;
        } catch {
          failedRecipe = null;
        }
        AG_CRM_API.sendRecipeFeedback({
          domain,
          status: "failure",
          lead_count: 0,
          url: window.location.href
        }).catch(() => {});
      }

      // Step 2 — paid path: one AI call that returns leads AND a recipe to learn from.
      setStatus(
        failedRecipe
          ? "Saved recipe stopped working — asking AI to extract and repair the recipe…"
          : "Sending page to AI extractor. This can take a minute on long pages…"
      );
      const content = window.AG_CRM.collectPageContentForAi();
      if (!content.pageText) throw new Error("No readable text found on this page.");
      const response = await AG_CRM_API.extractLeadsAi({
        ...content,
        domSkeleton: window.AG_CRM.collectDomSkeletonForAi(),
        wantRecipe: true,
        previousRecipe: failedRecipe
      });
      aiState.leads = response.leads || [];
      aiState.model = response.model || "";
      aiState.source = "llm";
      writeAiCache(aiState.leads, aiState.model, "llm");
      renderAiLeads();

      // Step 3 — learn: verify the proposed recipe against this page and save it.
      let recipeSaved = false;
      if (response.recipe && aiState.leads.length) {
        recipeSaved = await validateAndSaveRecipe(response.recipe, aiState.leads, aiState.model);
      }

      if (!aiState.leads.length) {
        setStatus("AI found no leads on this page.");
        showAiActivity("AI finished — no leads found on this page.", "error");
      } else {
        const msg =
          `AI found ${aiState.leads.length} lead(s). Review in the panel and click Save selected.`;
        setStatus(`${msg}${recipeSaved ? ` Recipe learned — future scans on ${domain} are free.` : ""}`);
        showAiActivity(`✓ ${aiState.leads.length} lead(s) found — review in the AG CRM panel (bottom-right).`);
      }
      console.info("[AG CRM AI] extraction completed", {
        url: content.url,
        lead_count: aiState.leads.length,
        model: aiState.model,
        recipe_saved: recipeSaved,
        truncated: response.truncated
      });
    } catch (error) {
      console.warn("[AG CRM AI] extraction failed", error);
      setBanner(error.message, "error");
      showAiActivity(`AI extraction failed: ${error.message}`, "error");
      setStatus("");
    } finally {
      aiState.busy = false;
      els.aiExtract.disabled = false;
      els.aiExtract.textContent = "✨ Get all leads (AI)";
    }
  }

  async function saveSelectedAiLeads() {
    if (aiState.busy) return;
    const checks = [...els.aiList.querySelectorAll(".ai-lead-check:checked")];
    if (!checks.length) {
      setStatus("Select at least one lead to save.");
      return;
    }
    aiState.busy = true;
    els.aiSave.disabled = true;
    els.aiSave.textContent = "Saving…";
    let saved = 0;
    let failed = 0;

    for (const check of checks) {
      const index = Number(check.dataset.index);
      const lead = aiState.leads[index];
      const resultEl = els.aiList.querySelector(`[data-result="${index}"]`);
      if (!lead) continue;
      try {
        const payloadLead = {
          ...lead,
          capture_metadata: {
            extractor: aiState.source === "recipe" ? "recipe" : "llm",
            llm_model: aiState.model,
            llm_confidence: lead.confidence,
            recipe_domain: aiState.source === "recipe" ? pageDomain() : undefined,
            capture_context: lead.city ? { city: lead.city } : undefined
          },
          source: {
            url: window.location.href,
            domain: window.location.hostname.replace(/^www\./, ""),
            platform: window.location.hostname.replace(/^www\./, ""),
            captured_at: new Date().toISOString()
          }
        };
        const result = await AG_CRM_API.upsertContact(payloadLead, {
          note: aiState.source === "recipe" ? "Captured with saved site recipe." : "Captured with AI extraction.",
          reviewStatus: "pending"
        });
        saved += 1;
        check.checked = false;
        check.disabled = true;
        if (resultEl) {
          resultEl.textContent = result.status === "created" ? "Saved ✓" : "Updated existing ✓";
          resultEl.className = "ai-lead-result ok";
        }
      } catch (error) {
        failed += 1;
        console.warn("[AG CRM AI] lead save failed", { lead: lead.name || lead.company_name, error });
        if (resultEl) {
          resultEl.textContent = `Failed: ${error.message}`;
          resultEl.className = "ai-lead-result error";
        }
      }
    }

    aiState.busy = false;
    els.aiSave.disabled = false;
    els.aiSave.textContent = "Save selected to CRM";
    setStatus(`AI leads saved: ${saved}${failed ? ` · failed: ${failed}` : ""}. Marked as pending review in CRM.`);
    console.info("[AG CRM AI] save selected finished", { saved, failed });
  }

  els.aiExtract.addEventListener("click", () =>
    extractLeadsWithAi().catch((error) => {
      console.warn("[AG CRM AI] panel button failed", error);
      showAiActivity(`AI extraction failed: ${error.message}`, "error");
      setBanner(error.message, "error");
    })
  );
  els.aiRescan.addEventListener("click", () => extractLeadsWithAi({ skipCache: true, forceLlm: true }));
  els.aiSave.addEventListener("click", saveSelectedAiLeads);
  els.aiSelectAll.addEventListener("change", () => {
    for (const check of els.aiList.querySelectorAll(".ai-lead-check:not(:disabled)")) {
      check.checked = els.aiSelectAll.checked;
    }
  });

  function openPanel({ skipScan = false } = {}) {
    state.open = true;
    panel.classList.remove("hidden");
    if (!skipScan) scanPage();
  }

  function closePanel() {
    state.open = false;
    panel.classList.add("hidden");
  }

  openBtn.addEventListener("click", async () => {
    if (!window.AG_CRM_isHostEnabled?.()) {
      setStatus("Enable this site in the AG CRM extension popup first.");
      return;
    }
    if (state.open) closePanel();
    else openPanel();
  });
  panel.querySelector("#ag-crm-close").addEventListener("click", closePanel);
  els.reveal.addEventListener("click", revealAndRescan);
  els.save.addEventListener("click", saveLead);

  function maybeShowLauncher() {
    if (!window.AG_CRM_isHostEnabled?.()) {
      root.style.display = "none";
      return;
    }
    root.style.display = "block";
  }

  let launcherTimer;
  function scheduleLauncherCheck() {
    window.clearTimeout(launcherTimer);
    launcherTimer = window.setTimeout(() => {
      maybeShowLauncher();
    }, 500);
  }

  maybeShowLauncher();
  document.addEventListener("ag-crm:host-enabled", () => maybeShowLauncher());
  const observer = new MutationObserver(() => scheduleLauncherCheck());
  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleLauncherCheck();
      if (state.open) scanPage();
    }
  }, 1000);

  window.__agCrmRunAiExtract = (options = {}) => extractLeadsWithAi(options);
  window.__agCrmPageUiInitialized = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "ag-crm:run-ai-extract") return;
    window.__agCrmRunAiExtract({ fromPopup: true });
    sendResponse({ ok: true, started: true });
  });
})();
