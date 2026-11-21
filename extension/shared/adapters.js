var AG_CRM_ADAPTERS = {
  registry: {},

  register(adapter) {
    if (!adapter?.id) return;
    this.registry[adapter.id] = adapter;
  },

  get(id) {
    return this.registry[id] || null;
  },

  list() {
    return Object.values(this.registry);
  },

  isFallback(adapter) {
    return !adapter || adapter.fallback === true || adapter.id === "generic" || adapter.id === "universal";
  },

  detectForUrl(url = "") {
    try {
      const hostname = new URL(url).hostname;
      for (const adapter of this.list()) {
        if (this.isFallback(adapter)) continue;
        if (adapter.hostPattern?.test(hostname)) return adapter;
      }
    } catch {
      // ignore
    }
    return this.registry.universal || this.registry.generic || null;
  },

  detectForLocation() {
    if (typeof window !== "undefined" && window.location?.href) {
      return this.detectForUrl(window.location.href);
    }
    return this.registry.universal || this.registry.generic || null;
  }
};

AG_CRM_ADAPTERS.register({
  id: "generic",
  label: "Generic web page",
  hostPattern: /.*/,
  fallback: true
});

// Universal adapter: matches every site with no bespoke config. Capture is
// hybrid — free DOM heuristics run first, and the AI extractor
// (POST /api/extract/ai) is the fallback for anything they miss.
AG_CRM_ADAPTERS.register({
  id: "universal",
  label: "Universal (heuristics + AI)",
  hostPattern: /.*/,
  fallback: true,
  supportsAiExtraction: true
});
