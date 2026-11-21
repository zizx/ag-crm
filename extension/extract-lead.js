function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function visibleText() {
  return document.body?.innerText || "";
}

function visibleLines(text) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractEmails(text) {
  return unique(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []);
}

function extractPhones(text) {
  const candidates = text.match(/(?:\+?\d[\d\s().*-]{7,}\d)/g) || [];
  return unique(
    candidates
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter((value) => value.replace(/[^\d]/g, "").length >= 8)
  ).slice(0, 5);
}

function meta(name) {
  return (
    document.querySelector(`meta[property="${name}"]`)?.content ||
    document.querySelector(`meta[name="${name}"]`)?.content ||
    ""
  );
}

function parseJsonLdPerson() {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || "{}");
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const flattened = entries.flatMap((entry) => entry["@graph"] || entry);
      const person = flattened.find((entry) => {
        const type = entry?.["@type"];
        return type === "Person" || (Array.isArray(type) && type.includes("Person"));
      });
      if (!person) continue;
      const worksFor = Array.isArray(person.worksFor) ? person.worksFor[0] : person.worksFor;
      return {
        name: person.name || "",
        title: person.jobTitle || "",
        company_name: worksFor?.name || "",
        emails: unique([person.email || ""]),
        phones: unique([person.telephone || ""]),
        website: person.url || worksFor?.url || "",
        address: formatStructuredAddress(person.address || worksFor?.address)
      };
    } catch {
      continue;
    }
  }
  return {};
}

function formatStructuredAddress(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    return [
      value.streetAddress,
      value.addressLocality,
      value.addressRegion,
      value.postalCode,
      value.addressCountry
    ]
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

function cleanCompany(value = "") {
  return value
    .replace(/\s+(?:in|based in)\s+.+$/i, "")
    .replace(/\s*[|•].+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHost(value = "") {
  return String(value || "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .toLowerCase();
}

function isLikelySourceHost(host = "", sourceDomain = "") {
  const normalized = normalizeHost(host);
  const source = normalizeHost(sourceDomain);
  if (!normalized) return true;
  if (source && (normalized === source || normalized.endsWith(`.${source}`))) return true;
  if (/linkedin|facebook|twitter|instagram|youtube|google|apple|microsoft|cloudflare|cdn/i.test(normalized)) {
    return true;
  }
  return false;
}

function isInvalidCompanyName(value = "", sourceDomain = "") {
  const cleaned = cleanCompany(value);
  if (!cleaned) return true;
  if (isLikelySourceHost(cleaned, sourceDomain)) return true;
  if (/^https?:\/\//i.test(cleaned)) return true;
  if (/^[a-z0-9.-]+\.(com|net|org|io|co|sa|ae)$/i.test(cleaned)) return true;
  return false;
}

function findNameIndex(lines, name = "") {
  if (!name) return -1;
  const lower = name.toLowerCase();
  return lines.findIndex((line) => {
    const candidate = line.toLowerCase();
    return candidate === lower || candidate.startsWith(`${lower} `);
  });
}

function profileWindow(lines, name = "", radius = 10) {
  const nameIndex = findNameIndex(lines, name);
  if (nameIndex < 0) return { lines: lines.slice(0, Math.min(lines.length, 20)), nameIndex: -1 };
  const start = Math.max(0, nameIndex);
  const end = Math.min(lines.length, nameIndex + radius + 1);
  return { lines: lines.slice(start, end), nameIndex: nameIndex - start };
}

function parseProfileBlock(blockLines, name = "") {
  let title = "";
  let company_name = "";
  const nameIndex = findNameIndex(blockLines, name);

  for (let index = 0; index < blockLines.length; index += 1) {
    const line = blockLines[index];
    if (name && line.toLowerCase() === name.toLowerCase()) continue;

    const atOnly = line.match(/^at\s+(.+)$/i);
    if (atOnly && !company_name) {
      if (nameIndex < 0 || index >= nameIndex) {
        company_name = cleanCompany(atOnly[1]);
      }
      continue;
    }

    const roleAt = line.match(/^(.+?)\s+at\s+(.+)$/i);
    if (roleAt && !/@/.test(line) && line.length <= 180) {
      const maybeTitle = roleAt[1].trim();
      const maybeCompany = cleanCompany(roleAt[2]);
      if (nameIndex >= 0 && index < nameIndex) {
        if (!title && maybeTitle.length > 1 && maybeTitle.length < 80) title = maybeTitle;
        continue;
      }
      if (!title && maybeTitle.length > 1 && maybeTitle.length < 80) title = maybeTitle;
      if (!company_name && maybeCompany) company_name = maybeCompany;
    }
  }

  return { title, company_name };
}

function extractCompanyFromDom(name = "") {
  const heading =
    document.querySelector("h1") ||
    [...document.querySelectorAll("h2, h3")].find((node) => {
      const text = (node.innerText || "").trim();
      return name && text.toLowerCase() === name.toLowerCase();
    });
  if (!heading) return "";

  const container =
    heading.closest?.("section, article, main, [class*='profile'], [class*='hero'], [class*='card']") ||
    heading.parentElement;
  if (!container) return "";

  for (const link of container.querySelectorAll("a[href]")) {
    const text = (link.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || (name && text.toLowerCase() === name.toLowerCase())) continue;
    const href = link.getAttribute("href") || "";
    if (/^mailto:|^tel:|^#/.test(href) || /\/profile\//i.test(href)) continue;

    const atOnly = text.match(/^at\s+(.+)$/i);
    if (atOnly) return cleanCompany(atOnly[1]);
    if (!/\bat\b/i.test(text) && text.length >= 2 && text.length <= 120) return cleanCompany(text);
  }

  let sibling = heading.nextElementSibling;
  for (let step = 0; step < 6 && sibling; step += 1) {
    const text = (sibling.innerText || "").replace(/\s+/g, " ").trim();
    const atOnly = text.match(/^at\s+(.+)$/i);
    if (atOnly) return cleanCompany(atOnly[1]);
    sibling = sibling.nextElementSibling;
  }

  return "";
}

function extractTitleFromBlock(blockLines, name = "") {
  const titleLabels = [
    "Chief Executive Officer",
    "Regional Sales Manager",
    "Sales Manager",
    "Managing Director",
    "General Manager",
    "CEO",
    "Founder",
    "Partner",
    "Consultant",
    "Director",
    "Manager",
    "Owner"
  ];

  for (const line of blockLines) {
    if (name && line.toLowerCase() === name.toLowerCase()) continue;
    if (/^at\s+/i.test(line)) continue;
    if (line.length > 120 || /@/.test(line)) continue;

    const roleAt = line.match(/^(.+?)\s+at\s+(.+)$/i);
    if (roleAt) return roleAt[1].trim();

    const label = titleLabels.find((candidate) => new RegExp(`\\b${candidate}\\b`, "i").test(line));
    if (label && line.length <= 80) return label;
  }

  return "";
}

function extractWebsites(sourceDomain = "") {
  const results = [];

  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = (anchor.getAttribute("href") || "").trim();
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) continue;
    try {
      const url = new URL(href, window.location.href);
      const host = normalizeHost(url.hostname);
      if (isLikelySourceHost(host, sourceDomain)) continue;
      if (/\/profile\//i.test(url.pathname)) continue;
      if (/\.(pdf|png|jpg|jpeg|svg|webp)$/i.test(url.pathname)) continue;
      results.push(`${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`.replace(/\/$/, ""));
    } catch {
      continue;
    }
  }

  const domainPattern = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|law|legal|me|info|biz|ae|sa|uk|au|sg)\b/gi;
  for (const match of visibleText().match(domainPattern) || []) {
    const host = normalizeHost(match);
    if (isLikelySourceHost(host, sourceDomain)) continue;
    results.push(`https://${host}`);
  }

  return unique(results).slice(0, 3);
}

function isLikelyCityCountry(line = "") {
  return /^(?:Riyadh|Jeddah|Dubai|Abu Dhabi|London|New York|Sydney|Tokyo|Singapore|Hong Kong|Mumbai|Berlin|Paris),?\s+[A-Za-z\s.'-]+$/i.test(
    line.trim()
  );
}

function extractAddress(allLines, profileLines, name = "") {
  const addressHints =
    /\b(level|floor|street|st\.|road|rd\.|avenue|ave|center|centre|tower|building|suite|unit|district|plaza|park|complex)\b/i;

  const candidates = [];

  for (const line of allLines) {
    if (/\bshow\s+(?:number|phone|telephone|mobile)\b/i.test(line)) continue;
    if (/^\+\d/.test(line) || /^\+?\d[\d\s().*-]{7,}$/.test(line)) continue;
    if (/@/.test(line)) continue;
    if (line.length < 10 || line.length > 220) continue;
    if (name && line.toLowerCase() === name.toLowerCase()) continue;
    if (/^at\s+/i.test(line)) continue;
    if (/^[a-z0-9.-]+\.(com|net|org|io|co|sa|ae)$/i.test(line.trim())) continue;

    if (addressHints.test(line)) {
      candidates.push({ line, score: 20 });
      continue;
    }

    if (isLikelyCityCountry(line)) {
      candidates.push({ line, score: 5 });
    }
  }

  for (const line of profileLines) {
    if (isLikelyCityCountry(line) && !addressHints.test(line)) {
      candidates.push({ line, score: 8 });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.line.length - a.line.length);
  return candidates[0]?.line || "";
}

function extractName(emails) {
  const h1 = document.querySelector("h1")?.innerText?.trim();
  if (h1 && h1.length <= 80) return h1;
  const title = document.title.split(/[|–-]/)[0]?.trim();
  if (title && title.length <= 80) return title;
  const emailName = emails[0]?.split("@")[0]?.replace(/[._-]+/g, " ");
  return emailName || "";
}

function pickCompany(candidates, sourceDomain) {
  for (const candidate of candidates) {
    const cleaned = cleanCompany(candidate);
    if (!isInvalidCompanyName(cleaned, sourceDomain)) return cleaned;
  }
  return "";
}

function getProfilePageType() {
  const path = window.location.pathname || "";
  if (/\/(?:company|companies|business|businesses|organization|organisation|firm)s?\//i.test(path)) return "business";
  if (/\/(?:people|person|team|staff|member|members|profile)\//i.test(path)) return "person";
  return "unknown";
}

function looksLikeCompanyPageTitle(name = "", companyName = "") {
  const normalized = String(name || "").trim().toLowerCase();
  const company = String(companyName || "").trim().toLowerCase();
  if (!normalized) return false;
  if (company && (normalized === company || company.startsWith(normalized) || normalized.startsWith(company.split(" - ")[0]))) {
    return true;
  }
  return /\b(l\.p\.?|llc|ltd|limited|inc|corp|corporation|branch|trading|law firm|company|co\.|group|international)\b/i.test(
    name
  );
}

function applyCaptureContext(lead, captureContext = {}) {
  const warnings = [];
  const fieldMeta = lead.field_meta || {};

  if (captureContext.person_name && !String(lead.name || "").trim()) {
    lead.name = normalizeListingPersonName(captureContext.person_name, captureContext.company_name);
    fieldMeta.name = { source: "directory_card", confidence: "high" };
  } else if (captureContext.listing_tab === "people" && captureContext.person_name) {
    const normalizedPerson = normalizeListingPersonName(captureContext.person_name, captureContext.company_name);
    if (normalizedPerson) {
      const pageIsCompanyTitle =
        lead.name &&
        (lead.name.toLowerCase() === (captureContext.company_name || "").toLowerCase() ||
          looksLikeCompanyPageTitle(lead.name, captureContext.company_name));
      if (pageIsCompanyTitle) {
        lead.name = normalizedPerson;
        fieldMeta.name = { source: "directory_card", confidence: "high" };
      } else if (!lead.name) {
        lead.name = normalizedPerson;
        fieldMeta.name = { source: "directory_card", confidence: "high" };
      } else if (normalizedPerson.toLowerCase() !== lead.name.toLowerCase()) {
        warnings.push(`Name mismatch: listing "${normalizedPerson}" vs page "${lead.name}"`);
      }
    }
  } else if (
    captureContext.person_name &&
    lead.name &&
    captureContext.person_name.trim().toLowerCase() !== lead.name.trim().toLowerCase()
  ) {
    warnings.push(`Name mismatch: listing "${captureContext.person_name}" vs page "${lead.name}"`);
  }

  const listingCompany = cleanCompany(captureContext.company_name || "");
  const extractedCompany = cleanCompany(lead.company_name || "");
  if (listingCompany) {
    if (!extractedCompany || isInvalidCompanyName(extractedCompany, lead.source?.domain || "")) {
      if (extractedCompany && extractedCompany !== listingCompany) {
        warnings.push(`Company replaced "${extractedCompany}" with listing "${listingCompany}"`);
      }
      lead.company_name = listingCompany;
      fieldMeta.company_name = { source: "directory_card", confidence: "high" };
    } else if (extractedCompany.toLowerCase() !== listingCompany.toLowerCase()) {
      warnings.push(`Company mismatch: listing "${listingCompany}" vs page "${extractedCompany}"`);
      lead.company_name = listingCompany;
      fieldMeta.company_name = { source: "directory_card", confidence: "high" };
    }
  }

  if (getProfilePageType() === "business" && listingCompany && !lead.name) {
    lead.name = listingCompany;
    fieldMeta.name = { source: "business_profile", confidence: "medium" };
  }

  lead.field_meta = fieldMeta;
  lead.validation_warnings = warnings;
  return lead;
}

function extractPdfLinksFromPage() {
  const links = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = (anchor.getAttribute("href") || "").trim();
    if (!href) continue;
    const text = (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim();
    let url;
    try {
      url = new URL(href, window.location.href).href;
    } catch {
      continue;
    }
    const isPdf = /\.pdf(?:$|[?#])/i.test(url) || /brochure|download/i.test(text);
    if (!isPdf) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({
      url,
      label: text || basenameFromUrl(url),
      mime_type: "application/pdf"
    });
  }
  return links;
}

function basenameFromUrl(url = "") {
  try {
    const parts = new URL(url).pathname.split("/");
    return parts[parts.length - 1] || "attachment.pdf";
  } catch {
    return "attachment.pdf";
  }
}

function resolveActiveAdapter() {
  if (typeof AG_CRM_ADAPTERS === "undefined") return null;
  return AG_CRM_ADAPTERS.detectForLocation();
}

const NOISE_HOST_PATTERN =
  /(?:^|\.)((?:aliexpress|amazon|ebay|etsy|walmart|temu|shein|target|bestbuy|wayfair|overstock|newegg|shopify|google|facebook|twitter|instagram|youtube|reddit|wikipedia|github|linkedin|tiktok|pinterest|snapchat|bing|yahoo|microsoft|apple|netflix|spotify|aliexpress)(?:\.[a-z]{2,})*)$/i;

const NOISE_PATH_PATTERN =
  /\/(?:item|product|products|p\/|dp\/|itm\/|listing|shop|cart|checkout|search|category|categories|collections?|deals|promotion|i\/)\//i;

function normalizePageHost(hostname = "") {
  return String(hostname || window.location.hostname).replace(/^www\./i, "").toLowerCase();
}

function isNoiseHost(hostname = "") {
  return NOISE_HOST_PATTERN.test(normalizePageHost(hostname));
}

function isFallbackAdapter(adapter = null) {
  const active = adapter || resolveActiveAdapter();
  if (typeof AG_CRM_ADAPTERS !== "undefined" && AG_CRM_ADAPTERS.isFallback) {
    return AG_CRM_ADAPTERS.isFallback(active);
  }
  return !active || active.id === "generic" || active.id === "universal";
}

function isHostCaptureEnabled() {
  if (typeof window.__agCrm_isHostEnabled === "function") {
    return window.__agCrm_isHostEnabled();
  }
  return true;
}

function genericPageHasPersonContactSignals() {
  const text = visibleText();
  const emails = extractEmails(text);
  const phones = extractPhones(text);
  if (!emails.length && !phones.length) return false;

  const structured = parseJsonLdPerson();
  if (structured.name && (structured.emails?.length || structured.phones?.length)) return true;

  const heading = document.querySelector("h1")?.innerText?.trim() || "";
  if (!heading || heading.length > 80) return false;
  if (/\$|USD|SAR|€|£|AED|\d+\s*%\s*off|free shipping|add to cart|buy now|\|\s*\d+\s*sold/i.test(heading)) {
    return false;
  }
  if (/^(?:home|shop|sale|deals|products?|search results|categories)/i.test(heading)) return false;

  const personalEmails = emails.filter(
    (email) => !/^(?:noreply|no-reply|support|help|info|sales|newsletter|mailer-daemon|customerservice)@/i.test(email)
  );
  const wordCount = heading.split(/\s+/).filter(Boolean).length;
  if (personalEmails.length && wordCount >= 2 && heading.length <= 64) return true;
  if (phones.length && wordCount >= 2 && heading.length <= 64 && personalEmails.length) return true;

  return false;
}

function genericPageLooksLikeContactProfile() {
  if (isNoiseHost()) return false;

  const path = window.location.pathname || "";
  if (NOISE_PATH_PATTERN.test(`${path}/`)) return false;

  if (/\/(?:contact|about|team|people|staff|bio|directory|lawyer|attorney|profile|member|our-team)\b/i.test(path)) {
    return genericPageHasPersonContactSignals();
  }

  return genericPageHasPersonContactSignals();
}

function genericPageLooksCapturable() {
  return genericPageLooksLikeContactProfile();
}

function extractLeadFromPage(options = {}) {
  const adapter = resolveActiveAdapter();
  if (adapter?.extractLead && !isFallbackAdapter(adapter)) {
    const captureContext = options.captureContext || options.context || {};
    const lead = adapter.extractLead({ captureContext });
    if (lead?.name || lead?.company_name || lead?.emails?.length || lead?.phones?.length) {
      return lead;
    }
  }

  const captureContext = options.captureContext || options.context || {};
  const text = visibleText();
  const lines = visibleLines(text);
  const structured = parseJsonLdPerson();
  const emails = extractEmails(text);
  const phones = extractPhones(text);
  const domain = window.location.hostname.replace(/^www\./, "");
  const pageType = getProfilePageType();
  let name = structured.name || extractName(emails);
  if (!name && pageType === "business") {
    name = document.querySelector("h1")?.innerText?.trim() || "";
  }
  const { lines: profileLines } = profileWindow(lines, name, 10);
  const profileBlock = parseProfileBlock(profileLines, name);
  const domCompany = extractCompanyFromDom(name);
  const websites = extractWebsites(domain);
  const address = structured.address || extractAddress(lines, profileLines, name);
  const revealAvailable = /\bshow\s+(?:number|phone|telephone|mobile)\b/i.test(text);
  const sourcePlatform = meta("og:site_name") || domain;

  const company_name = pickCompany(
    [captureContext.company_name, structured.company_name, profileBlock.company_name, domCompany],
    domain
  );
  const title = structured.title || profileBlock.title || extractTitleFromBlock(profileLines, name);

  let lead = {
    name,
    title,
    company_name,
    emails: unique([...(structured.emails || []), ...emails]),
    phones: unique([...(structured.phones || []), ...phones]),
    website: structured.website || websites[0] || "",
    websites,
    address,
    tags: [],
    phone_reveal_available: revealAvailable,
    profile_page_type: pageType,
    pdf_links: extractPdfLinksFromPage(),
    source: {
      url: window.location.href,
      domain,
      platform: sourcePlatform,
      captured_at: new Date().toISOString()
    }
  };

  lead = applyCaptureContext(lead, captureContext);
  lead.capture_metadata = {
    capture_context: captureContext,
    field_meta: lead.field_meta || {},
    validation_warnings: lead.validation_warnings || [],
    profile_page_type: pageType
  };
  delete lead.field_meta;
  delete lead.validation_warnings;
  return lead;
}

function normalizeListingPersonName(raw = "", companyName = "") {
  let text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.replace(/^[A-Z]{2,3}\s+(?=[A-Za-z])/u, "");
  if (companyName) {
    const idx = text.toLowerCase().indexOf(companyName.toLowerCase());
    if (idx > 0) text = text.slice(0, idx).trim();
  }
  text = text.replace(
    /\s+(?:CEO|CFO|COO|CTO|Managing Director|Regional Sales Manager|Practice Manager|Attorney at law|Attorney|LAWYER|Lawyer)\s*$/i,
    ""
  ).trim();
  if (text.length > 80) {
    text = text.split(/\s+(?=[A-Z][a-z]+(?: and | & ))/)[0] || text.slice(0, 80);
  }
  return text.trim();
}

function getPageKindFromLocation() {
  const adapter = resolveActiveAdapter();
  if (adapter?.getPageKind) {
    const kind = adapter.getPageKind();
    if (kind !== "other") return kind;
  }
  const path = window.location.pathname || "";
  if (/\/profile\//i.test(path)) return "profile";
  if (genericPageLooksCapturable()) return "profile";
  return "other";
}

function profilePageLooksReady() {
  const path = window.location.pathname || "";
  if (!/\/profile\//i.test(path)) {
    if (genericPageLooksCapturable()) return true;
    return false;
  }
  const heading = document.querySelector(
    "h1, h2, [class*='profile-name'], [class*='member-name'], [class*='person-name']"
  );
  if (heading?.innerText?.trim()) return true;
  const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  if (/show number|reveal|@|\+|\d{3}.*\d{4}/i.test(bodyText) && bodyText.length > 80) return true;
  return false;
}

function pageHasCapturableContacts() {
  if (!isHostCaptureEnabled()) return false;
  const adapter = resolveActiveAdapter();
  if (adapter?.pageHasCapturableContacts) {
    const adapterResult = adapter.pageHasCapturableContacts();
    if (adapterResult) return true;
    if (!isFallbackAdapter(adapter)) return false;
  }
  const kind = getPageKindFromLocation();
  if (kind === "profile") return profilePageLooksReady();
  return genericPageLooksLikeContactProfile();
}

function collectPageContentForAi() {
  const OWN_UI_IDS = [
    "ag-crm-launcher",
    "ag-crm-capture-toast"
  ];
  let bodyText = "";
  const body = document.body;
  if (body) {
    const hidden = [];
    for (const id of OWN_UI_IDS) {
      const node = document.getElementById(id);
      if (node && node.style.display !== "none") {
        hidden.push([node, node.style.display]);
        node.style.display = "none";
      }
    }
    try {
      bodyText = (body.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    } finally {
      for (const [node, display] of hidden) node.style.display = display;
    }
  }

  const pageHost = window.location.hostname.replace(/^www\./, "");
  const contactLinks = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = String(anchor.getAttribute("href") || "").trim();
    if (!href) continue;
    let normalized = "";
    if (/^mailto:/i.test(href) || /^tel:/i.test(href)) {
      normalized = href;
    } else if (/^https?:/i.test(href)) {
      try {
        const linkHost = new URL(href).hostname.replace(/^www\./, "");
        if (linkHost && linkHost !== pageHost) normalized = href.split("#")[0];
      } catch {
        continue;
      }
    }
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    contactLinks.push(normalized);
    if (contactLinks.length >= 200) break;
  }

  return {
    url: window.location.href,
    title: document.title || "",
    pageText: bodyText,
    contactLinks
  };
}

const AG_CRM_OWN_UI_IDS = [
  "ag-crm-launcher",
  "ag-crm-capture-toast"
];

function collectDomSkeletonForAi(maxChars = 18000) {
  const body = document.body;
  if (!body) return "";
  const clone = body.cloneNode(true);

  for (const id of AG_CRM_OWN_UI_IDS) {
    clone.querySelector(`#${id}`)?.remove();
  }
  for (const node of clone.querySelectorAll("script, style, noscript, svg, iframe, canvas, video, audio, template, link, meta")) {
    node.remove();
  }

  const KEEP_ATTRS = new Set(["id", "class", "href", "role", "type", "aria-label"]);
  for (const el of clone.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (!KEEP_ATTRS.has(attr.name)) {
        el.removeAttribute(attr.name);
      } else if (attr.value.length > 120) {
        el.setAttribute(attr.name, attr.value.slice(0, 120));
      }
    }
  }

  // Collapse runs of similar siblings (directory cards) so big listings fit in
  // the budget while the repeated structure stays visible to the model.
  (function collapseRepeats(parent) {
    const groups = new Map();
    for (const child of [...parent.children]) {
      const key = `${child.tagName}.${child.getAttribute("class") || ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(child);
    }
    for (const members of groups.values()) {
      if (members.length > 3) {
        members[0].setAttribute("data-ag-repeated", String(members.length));
        for (const extra of members.slice(3)) extra.remove();
      }
    }
    for (const child of [...parent.children]) collapseRepeats(child);
  })(clone);

  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const text = node.textContent.replace(/\s+/g, " ").trim();
    node.textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  const html = clone.innerHTML.replace(/>\s+</g, "><").trim();
  return html.length > maxChars ? html.slice(0, maxChars) : html;
}

function runExtractionRecipe(recipe) {
  if (!recipe || !recipe.fields || typeof recipe.fields !== "object") return [];
  let scopes;
  if (recipe.list_selector) {
    try {
      scopes = [...document.querySelectorAll(recipe.list_selector)];
    } catch {
      return [];
    }
  } else {
    scopes = [document];
  }

  const leads = [];
  for (const scope of scopes.slice(0, 500)) {
    const lead = {
      name: "",
      company_name: "",
      title: "",
      emails: [],
      phones: [],
      website: "",
      address: "",
      city: "",
      record_kind: recipe.record_kind === "company" ? "company" : "person",
      confidence: 0.8
    };
    for (const [field, def] of Object.entries(recipe.fields)) {
      if (!def?.selector) continue;
      let nodes;
      try {
        nodes = [...scope.querySelectorAll(def.selector)];
      } catch {
        continue;
      }
      if (!nodes.length) continue;
      const values = nodes
        .slice(0, 5)
        .map((node) =>
          def.attr && def.attr !== "text"
            ? node.getAttribute(def.attr) || ""
            : node.innerText || node.textContent || ""
        )
        .map((value) => String(value).replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (!values.length) continue;

      if (field === "email") {
        lead.emails = [
          ...new Set(
            values
              .map((value) => value.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase())
              .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
          )
        ];
      } else if (field === "phone") {
        lead.phones = [
          ...new Set(
            values
              .map((value) => {
                const cleaned = value.replace(/^tel:/i, "").trim();
                const plus = cleaned.startsWith("+") ? "+" : "";
                return `${plus}${cleaned.replace(/[^\d]/g, "")}`;
              })
              .filter((value) => value.replace(/\D/g, "").length >= 7)
          )
        ];
      } else if (field === "website") {
        lead.website = values[0].slice(0, 300);
      } else {
        lead[field] = values[0].slice(0, 200);
      }
    }
    if (lead.name || lead.company_name || lead.emails.length || lead.phones.length) {
      leads.push(lead);
    }
  }
  return leads;
}

window.AG_CRM = window.AG_CRM || {};
window.AG_CRM.collectPageContentForAi = collectPageContentForAi;
window.AG_CRM.collectDomSkeletonForAi = collectDomSkeletonForAi;
window.AG_CRM.runExtractionRecipe = runExtractionRecipe;
window.AG_CRM.resolveAdapter = resolveActiveAdapter;
window.AG_CRM.isNoiseHost = isNoiseHost;
window.AG_CRM.extractLead = extractLeadFromPage;
window.AG_CRM.extractPdfLinks = extractPdfLinksFromPage;
window.AG_CRM.getPageKind = getPageKindFromLocation;
window.AG_CRM.profilePageLooksReady = profilePageLooksReady;
window.AG_CRM.getProfilePageType = getProfilePageType;
window.AG_CRM.pageHasCapturableContacts = pageHasCapturableContacts;
