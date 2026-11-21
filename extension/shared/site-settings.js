var AG_CRM_SITE = {
  STORAGE_KEY: "enabledCaptureHosts",

  normalizeHost(hostname = "") {
    return String(hostname || "")
      .replace(/^www\./i, "")
      .toLowerCase();
  },

  async getEnabledHosts() {
    const data = await chrome.storage.local.get({ [this.STORAGE_KEY]: {} });
    return data[this.STORAGE_KEY] || {};
  },

  async isEnabled(hostname = "") {
    const host = this.normalizeHost(hostname || (typeof location !== "undefined" ? location.hostname : ""));
    if (!host) return false;
    const hosts = await this.getEnabledHosts();
    return Boolean(hosts[host]?.enabled);
  },

  async enable(hostname = "") {
    const host = this.normalizeHost(hostname || location.hostname);
    const hosts = await this.getEnabledHosts();
    hosts[host] = {
      enabled: true,
      enabled_at: new Date().toISOString()
    };
    await chrome.storage.local.set({ [this.STORAGE_KEY]: hosts });
    return host;
  },

  async disable(hostname = "") {
    const host = this.normalizeHost(hostname || location.hostname);
    const hosts = await this.getEnabledHosts();
    delete hosts[host];
    await chrome.storage.local.set({ [this.STORAGE_KEY]: hosts });
    return host;
  },

  async toggle(hostname = "") {
    if (await this.isEnabled(hostname)) {
      await this.disable(hostname);
      return false;
    }
    await this.enable(hostname);
    return true;
  }
};

if (typeof self !== "undefined") {
  self.AG_CRM_SITE = AG_CRM_SITE;
}
