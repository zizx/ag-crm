var AG_CRM_API = {
  DEFAULT_CRM_URL: "http://127.0.0.1:3210",
  DEFAULT_ORG_ID: "org_default",

  async getCrmUrl() {
    const settings = await chrome.storage.local.get({ crmUrl: this.DEFAULT_CRM_URL });
    return String(settings.crmUrl || this.DEFAULT_CRM_URL).replace(/\/$/, "");
  },

  shouldUseBackgroundProxy() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage) && typeof document !== "undefined";
    } catch {
      return false;
    }
  },

  formatFetchError(message = "", crmUrl = this.DEFAULT_CRM_URL) {
    if (/failed to fetch|networkerror|network error|could not connect|connection refused/i.test(message)) {
      return `CRM is not reachable at ${crmUrl}. Start it with npm run dev, then reload this page.`;
    }
    return message || "CRM request failed.";
  },

  async fetchCrm(path, options = {}) {
    const crmUrl = await this.getCrmUrl();
    const fetchOptions = {
      method: options.method || "GET",
      headers: options.headers || { "content-type": "application/json" },
      body: options.body
    };
    if (fetchOptions.method === "GET" || fetchOptions.method === "HEAD") {
      delete fetchOptions.body;
    }

    if (this.shouldUseBackgroundProxy()) {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: "ag-crm:api-fetch",
            path,
            options: fetchOptions
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(this.formatFetchError(chrome.runtime.lastError.message, crmUrl)));
              return;
            }
            resolve(response || {});
          }
        );
      });
      if (result.networkError) {
        throw new Error(this.formatFetchError(result.networkError, crmUrl));
      }
      const body = result.body || {};
      if (!result.ok) {
        throw new Error(body.errors?.join(" ") || body.error || result.error || `CRM request failed (${result.status || 0}).`);
      }
      return body;
    }

    const url = path.startsWith("http") ? path : `${crmUrl}${path.startsWith("/") ? path : `/${path}`}`;
    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      throw new Error(this.formatFetchError(error.message, crmUrl));
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.errors?.join(" ") || body.error || "CRM request failed.");
    }
    return body;
  },

  async checkHealth() {
    return this.fetchCrm("/api/health");
  },

  safeDomain(url = "") {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  },

  splitList(value) {
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  },

  buildUpsertPayload(lead, { actorType = "extension", note = "", tags = [], reviewStatus = "" } = {}) {
    const sourceUrl = lead.source?.url || "";
    const sourceDomain = lead.source?.domain || this.safeDomain(sourceUrl);
    return {
      org_id: this.DEFAULT_ORG_ID,
      actor_type: actorType,
      capture_metadata: lead.capture_metadata || null,
      data_review_status: reviewStatus || (actorType === "scraper" ? "pending" : "confirmed"),
      source: sourceUrl
        ? {
            url: sourceUrl,
            domain: sourceDomain,
            platform: lead.source?.platform || sourceDomain,
            captured_at: lead.source?.captured_at || new Date().toISOString()
          }
        : undefined,
      contact: {
        name: lead.name || "",
        company_name: lead.company_name || "",
        title: lead.title || "",
        emails: lead.emails || [],
        phones: lead.phones || [],
        website: lead.website || "",
        address: lead.address || "",
        city: lead.city || "",
        record_kind: lead.record_kind || undefined,
        tags,
        note,
        capture_metadata: lead.capture_metadata || null
      }
    };
  },

  async extractLeadsAi({
    url = "",
    title = "",
    pageText = "",
    contactLinks = [],
    domSkeleton = "",
    wantRecipe = false,
    previousRecipe = null
  } = {}) {
    return this.fetchCrm("/api/extract/ai", {
      method: "POST",
      body: JSON.stringify({
        url,
        title,
        page_text: pageText,
        contact_links: contactLinks,
        dom_skeleton: domSkeleton,
        want_recipe: wantRecipe,
        previous_recipe: previousRecipe
      })
    });
  },

  async getExtractionRecipe(domain) {
    const params = new URLSearchParams({ domain });
    return this.fetchCrm(`/api/extract/recipes?${params.toString()}`, { method: "GET", headers: {} });
  },

  async saveExtractionRecipe(payload) {
    return this.fetchCrm("/api/extract/recipes", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async sendRecipeFeedback(payload) {
    return this.fetchCrm("/api/extract/recipes/feedback", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async logClientDebugEvent(payload) {
    return this.fetchCrm("/api/extract/debug/client", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async matchContact(lead) {
    const params = new URLSearchParams();
    params.set("org_id", this.DEFAULT_ORG_ID);
    if (lead.source?.url) params.set("source_url", lead.source.url);
    if (lead.name) params.set("name", lead.name);
    if (lead.company_name) params.set("company_name", lead.company_name);
    if (lead.emails?.length) params.set("emails", lead.emails.join(","));
    if (lead.phones?.length) params.set("phones", lead.phones.join(","));
    const ctx = lead.capture_metadata?.capture_context;
    if (ctx?.person_name) params.set("person_name", ctx.person_name);
    if (lead.capture_metadata) {
      params.set("capture_metadata", JSON.stringify(lead.capture_metadata));
    }
    return this.fetchCrm(`/api/contacts/match?${params.toString()}`, { method: "GET", headers: {} });
  },

  async upsertContact(lead, options = {}) {
    const payload = this.buildUpsertPayload(lead, options);
    return this.fetchCrm("/api/contacts/upsert", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  async recordIngestionEvent(event) {
    return this.fetchCrm("/api/ingestion-events", {
      method: "POST",
      body: JSON.stringify({
        org_id: this.DEFAULT_ORG_ID,
        actor_type: event.actor_type || "scraper",
        source: event.source || "",
        event_type: event.event_type || "scrape",
        status: event.status || "completed",
        summary: event.summary || "",
        meta: event.meta || {}
      })
    });
  },

  async dedupeContacts({ actorType = "extension" } = {}) {
    return this.fetchCrm("/api/contacts/dedupe", {
      method: "POST",
      body: JSON.stringify({
        org_id: this.DEFAULT_ORG_ID,
        actor_type: actorType
      })
    });
  },

  async deleteContact(contactId, { note = "Removed from extension.", actorType = "extension" } = {}) {
    return this.fetchCrm(`/api/contacts/${contactId}`, {
      method: "DELETE",
      body: JSON.stringify({
        org_id: this.DEFAULT_ORG_ID,
        actor_type: actorType,
        note
      })
    });
  },

  async updateContact(contactId, lead, { note = "", tags = [] } = {}) {
    const sourceUrl = lead.source?.url || "";
    const sourceDomain = lead.source?.domain || this.safeDomain(sourceUrl);
    return this.fetchCrm(`/api/contacts/${contactId}`, {
      method: "PATCH",
      body: JSON.stringify({
        org_id: this.DEFAULT_ORG_ID,
        actor_type: "extension",
        contact: {
          name: lead.name || "",
          company_name: lead.company_name || "",
          title: lead.title || "",
          emails: lead.emails || [],
          phones: lead.phones || [],
          website: lead.website || "",
          address: lead.address || "",
          tags,
          change_note: note
        },
        source: sourceUrl
          ? {
              url: sourceUrl,
              domain: sourceDomain,
              platform: lead.source?.platform || sourceDomain,
              captured_at: lead.source?.captured_at || new Date().toISOString()
            }
          : undefined
      })
    });
  },

  async markContactPendingReview(contactId, { note = "Flagged for review.", actorType = "extension" } = {}) {
    return this.fetchCrm(`/api/contacts/${contactId}/review`, {
      method: "POST",
      body: JSON.stringify({
        org_id: this.DEFAULT_ORG_ID,
        actor_type: actorType,
        status: "pending",
        note
      })
    });
  },

  async confirmContactReview(contactId, { actorType = "human", note = "" } = {}) {
    return this.fetchCrm(`/api/contacts/${contactId}/review`, {
      method: "POST",
      body: JSON.stringify({
        org_id: this.DEFAULT_ORG_ID,
        actor_type: actorType,
        status: "confirmed",
        note
      })
    });
  },

  async uploadContactFile(contactId, filePayload, { actorType = "scraper" } = {}) {
    return this.fetchCrm(`/api/contacts/${contactId}/files`, {
      method: "POST",
      body: JSON.stringify({
        org_id: this.DEFAULT_ORG_ID,
        actor_type: actorType,
        ...filePayload
      })
    });
  }
};
