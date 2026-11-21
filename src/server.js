import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename, copyFile, readdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";

function loadDotEnv(filePath) {
  try {
    if (!existsSync(filePath)) return;
    const lines = readFileSync(filePath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.error(`[env] failed to load ${filePath}: ${error.message}`);
  }
}

loadDotEnv(join(process.cwd(), ".env"));

const PORT = Number(process.env.PORT || 3210);
const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, "data");
const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");
const DATA_FILE = process.env.DATA_FILE ? resolve(process.env.DATA_FILE) : join(DATA_DIR, "crm.json");
const SECRETS_FILE = process.env.SECRETS_FILE ? resolve(process.env.SECRETS_FILE) : join(DATA_DIR, "secrets.json");
const RECIPES_FILE = join(DATA_DIR, "recipes.json");
const AI_DEBUG_DIR = join(DATA_DIR, "ai-debug");
const MAX_AI_DEBUG_REPORTS = 40;
const BACKUPS_DIR = join(DATA_DIR, "backups");
const MAX_BACKUPS = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_AI_PAGE_TEXT = 30000;
const MAX_AI_DOM_SKELETON = 20000;
const LLM_TIMEOUT_MS = 120000;
const RECIPE_MAX_CONSECUTIVE_FAILURES = 3;
const GHL_BASE_URL = process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

const DEFAULT_ORG_ID = "org_default";
const DEFAULT_USER_ID = "user_default";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function now() {
  return new Date().toISOString();
}

function createBaseData() {
  const stamp = now();
  return {
    organizations: [
      {
        id: DEFAULT_ORG_ID,
        name: "Default Organization",
        created_at: stamp,
        updated_at: stamp
      }
    ],
    users: [
      {
        id: DEFAULT_USER_ID,
        email: "owner@example.local",
        name: "CRM Owner",
        created_at: stamp,
        updated_at: stamp
      }
    ],
    memberships: [
      {
        id: "membership_default",
        org_id: DEFAULT_ORG_ID,
        user_id: DEFAULT_USER_ID,
        role: "owner",
        created_at: stamp,
        updated_at: stamp
      }
    ],
    contacts: [],
    companies: [],
    contact_methods: [],
    tags: [],
    contact_tags: [],
    activities: [],
    notes: [],
    tasks: [],
    files: [],
    sources: [],
    agent_actions: [],
    system_logs: [],
    ingestion_events: []
  };
}

async function ensureDataFile() {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  if (!existsSync(DATA_FILE)) {
    await writeFileAtomic(DATA_FILE, JSON.stringify(createBaseData(), null, 2));
  }
}

let dataQueue = Promise.resolve();

function enqueueDataOperation(operation) {
  const run = dataQueue.then(operation, operation);
  dataQueue = run.catch(() => {});
  return run;
}

async function writeFileAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

async function readJsonFile(filePath, { retries = 5 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const content = await readFile(filePath, "utf8");
      if (!content.trim()) {
        throw new SyntaxError(`Empty JSON file: ${filePath}`);
      }
      return JSON.parse(content);
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function readData() {
  return enqueueDataOperation(async () => {
    await ensureDataFile();
    const data = await readJsonFile(DATA_FILE);

    let changed = false;
    for (const source of data.sources || []) {
      if (!source.platform) {
        source.platform = source.domain || sourceDomain(source.url);
        changed = true;
      }
    }
    if (changed) {
      await writeFileAtomic(DATA_FILE, JSON.stringify(data, null, 2));
    }
    return data;
  });
}

async function writeData(data) {
  return enqueueDataOperation(async () => {
    await writeFileAtomic(DATA_FILE, JSON.stringify(data, null, 2));
  });
}

const DEFAULT_SECRETS = {
  llm: {
    provider: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "z-ai/glm-5.2",
    api_key: ""
  },
  gohighlevel: {
    private_integration_token: "",
    default_location_id: "",
    locations: []
  }
};

async function readSecrets() {
  let stored = {};
  try {
    stored = await readJsonFile(SECRETS_FILE, { retries: 2 });
  } catch {
    stored = {};
  }
  const secrets = {
    llm: { ...DEFAULT_SECRETS.llm, ...(stored.llm || {}) },
    gohighlevel: { ...DEFAULT_SECRETS.gohighlevel, ...(stored.gohighlevel || {}) }
  };
  if (process.env.LLM_PROVIDER) secrets.llm.provider = process.env.LLM_PROVIDER;
  if (process.env.LLM_BASE_URL) secrets.llm.base_url = process.env.LLM_BASE_URL;
  if (process.env.LLM_MODEL) secrets.llm.model = process.env.LLM_MODEL;
  if (process.env.LLM_API_KEY) secrets.llm.api_key = process.env.LLM_API_KEY;
  if (process.env.GHL_TOKEN) secrets.gohighlevel.private_integration_token = process.env.GHL_TOKEN;
  return secrets;
}

async function writeSecrets(secrets) {
  await writeFileAtomic(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

async function backupCrmData(reason = "scheduled") {
  try {
    if (!existsSync(DATA_FILE)) return null;
    await mkdir(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(BACKUPS_DIR, `crm-${stamp}.json`);
    await copyFile(DATA_FILE, target);
    const entries = (await readdir(BACKUPS_DIR)).filter((name) => /^crm-.*\.json$/.test(name)).sort();
    while (entries.length > MAX_BACKUPS) {
      const oldest = entries.shift();
      await unlink(join(BACKUPS_DIR, oldest)).catch(() => {});
    }
    console.log(`[backup] crm.json saved (${reason}) -> ${basename(target)}`);
    return target;
  } catch (error) {
    console.error(`[backup] failed (${reason}): ${error.message}`);
    return null;
  }
}

async function callLlmChat(messages, secrets) {
  const llm = secrets.llm;
  if (!llm.api_key) {
    throw new Error("LLM API key is not configured. Add it to data/secrets.json under llm.api_key.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(`${String(llm.base_url).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${llm.api_key}`,
        "content-type": "application/json",
        "x-title": "AG CRM Lead Extraction"
      },
      body: JSON.stringify({
        model: llm.model,
        messages,
        temperature: 0,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error?.message || `LLM request failed (HTTP ${response.status}).`);
    }
    return {
      content: body.choices?.[0]?.message?.content || "",
      model: body.model || llm.model,
      usage: body.usage || {}
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`LLM request timed out after ${LLM_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const AI_EXTRACT_SYSTEM_PROMPT = [
  "You extract sales leads (people and companies) from webpage text for a CRM.",
  "Respond with JSON only, matching exactly this shape:",
  '{"leads":[{"name":"","company_name":"","title":"","emails":[],"phones":[],"website":"","address":"","city":"","record_kind":"person","confidence":0.9}]}',
  "Rules:",
  "- Extract every distinct lead visible in the content (directory listings can contain many).",
  "- record_kind is \"person\" when the lead is an individual, \"company\" when only an organization is identified.",
  "- Keep names/titles/addresses in their original language (Arabic stays Arabic). Do not translate.",
  "- Only include data present in the content. Never invent or guess emails, phones, or websites.",
  "- Phone numbers: keep digits and leading + only, preserving country codes where shown.",
  "- website must be the lead's own site, not the directory/platform hosting the page.",
  "- Skip navigation, footer, and platform boilerplate. Skip entries with no name and no contact info.",
  "- Deduplicate entries. confidence is 0..1 for how certain you are this is a real lead.",
  '- If nothing can be extracted, return {"leads":[]}.'
].join("\n");

const AI_RECIPE_PROMPT_ADDENDUM = [
  "",
  "ALSO produce a reusable extraction RECIPE so a dumb scraper can extract the same leads from similar pages of this site without calling you again.",
  "Add a top-level \"recipe\" key to your JSON response:",
  '{"leads":[...],"recipe":{"list_selector":".result-card","fields":{"name":{"selector":"h3","attr":"text"},"email":{"selector":"a[href^=\'mailto:\']","attr":"href"},"phone":{"selector":"a[href^=\'tel:\']","attr":"href"},"title":{"selector":".job-title","attr":"text"},"company_name":{"selector":".firm","attr":"text"},"website":{"selector":"a.site","attr":"href"},"city":{"selector":".city","attr":"text"},"address":{"selector":".addr","attr":"text"}},"record_kind":"person"}}',
  "Recipe rules:",
  "- Derive selectors ONLY from the DOM skeleton provided (real classes/ids/tags). Never invent class names.",
  "- \"list_selector\" must match exactly one element per lead on listing pages. Omit it (or use \"\") when the page holds a single lead.",
  "- Field selectors are evaluated INSIDE each list element (or the whole page when list_selector is empty).",
  "- attr is \"text\" for visible text, or an attribute name like \"href\".",
  "- Only include fields the selectors can reliably capture. Plain CSS only — no :contains() or XPath.",
  "- If the page structure is too irregular for a reliable recipe, use \"recipe\": null."
].join("\n");

const AI_DEBUG_KINDS = [
  "ai-extract",
  "ai-extract-error",
  "recipe-save",
  "recipe-run-failure",
  "recipe-validation-failed",
  "client-event"
];

function debugSnippet(value = "", max = 4000) {
  const text = String(value || "");
  return {
    length: text.length,
    truncated: text.length > max,
    text: text.slice(0, max)
  };
}

// Debug reports exist so the next iteration on prompts/recipes can be driven
// by real inputs and raw LLM outputs instead of guesswork. No secrets inside.
async function writeAiDebugReport(kind, report) {
  try {
    if (!AI_DEBUG_KINDS.includes(kind)) kind = "client-event";
    await mkdir(AI_DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${stamp}-${kind}.json`;
    await writeFileAtomic(
      join(AI_DEBUG_DIR, fileName),
      JSON.stringify({ kind, time: now(), ...report }, null, 2)
    );
    const entries = (await readdir(AI_DEBUG_DIR)).filter((name) => name.endsWith(".json")).sort();
    while (entries.length > MAX_AI_DEBUG_REPORTS) {
      const oldest = entries.shift();
      await unlink(join(AI_DEBUG_DIR, oldest)).catch(() => {});
    }
    return fileName;
  } catch (error) {
    console.error(`[ai-debug] failed to write ${kind} report: ${error.message}`);
    return null;
  }
}

async function handleAiDebugList(res, searchParams) {
  const file = String(searchParams.get("file") || "").trim();
  try {
    if (file) {
      if (!/^[\w.-]+\.json$/.test(file)) {
        return sendJson(res, 422, { status: "validation_failed", errors: ["Invalid file name."] });
      }
      const report = await readJsonFile(join(AI_DEBUG_DIR, file), { retries: 1 });
      return sendJson(res, 200, { status: "ok", file, report });
    }
    let names = [];
    try {
      names = (await readdir(AI_DEBUG_DIR)).filter((name) => name.endsWith(".json")).sort().reverse();
    } catch {
      names = [];
    }
    const reports = [];
    for (const name of names.slice(0, MAX_AI_DEBUG_REPORTS)) {
      try {
        const report = await readJsonFile(join(AI_DEBUG_DIR, name), { retries: 1 });
        reports.push({
          file: name,
          kind: report.kind || "",
          time: report.time || "",
          url: report.url || report.request?.url || "",
          domain: report.domain || "",
          model: report.model || report.llm?.model || "",
          lead_count: report.parsed?.lead_count ?? report.lead_count,
          recipe_returned: report.parsed?.recipe ? true : report.recipe ? true : false,
          error: report.error || ""
        });
      } catch {
        reports.push({ file: name, kind: "unreadable" });
      }
    }
    return sendJson(res, 200, { status: "ok", reports });
  } catch (error) {
    return sendJson(res, 404, { status: "not_found", error: error.message });
  }
}

async function handleAiDebugClientEvent(req, res) {
  const payload = await parseJson(req);
  const kind = AI_DEBUG_KINDS.includes(payload.kind) ? payload.kind : "client-event";
  const file = await writeAiDebugReport(kind, {
    source: "extension",
    url: String(payload.url || "").slice(0, 500),
    domain: normalizeRecipeDomain(payload.domain || ""),
    detail: payload.detail && typeof payload.detail === "object" ? payload.detail : {},
    message: String(payload.message || "").slice(0, 1000)
  });
  return sendJson(res, 200, { status: "recorded", file });
}

function sanitizeExtractionRecipe(raw) {
  if (!raw || typeof raw !== "object") return null;
  const allowedFields = ["name", "company_name", "title", "email", "phone", "website", "address", "city"];
  const fields = {};
  for (const key of allowedFields) {
    const def = raw.fields?.[key];
    if (!def || typeof def !== "object") continue;
    const selector = String(def.selector || "").trim().slice(0, 300);
    if (!selector) continue;
    fields[key] = {
      selector,
      attr: String(def.attr || "text").trim().slice(0, 50) || "text"
    };
  }
  if (!Object.keys(fields).length) return null;
  return {
    list_selector: String(raw.list_selector || "").trim().slice(0, 300),
    fields,
    record_kind: raw.record_kind === "company" ? "company" : "person"
  };
}

async function readRecipesFile() {
  try {
    const parsed = await readJsonFile(RECIPES_FILE, { retries: 2 });
    return { recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [] };
  } catch {
    return { recipes: [] };
  }
}

async function writeRecipesFile(store) {
  await writeFileAtomic(RECIPES_FILE, JSON.stringify(store, null, 2));
}

function normalizeRecipeDomain(value = "") {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

async function handleRecipeGet(res, searchParams) {
  const domain = normalizeRecipeDomain(searchParams.get("domain") || "");
  if (!domain) {
    return sendJson(res, 422, { status: "validation_failed", errors: ["domain is required."] });
  }
  const store = await readRecipesFile();
  const record = store.recipes.find((row) => row.domain === domain) || null;
  return sendJson(res, 200, { recipe: record });
}

async function handleRecipeSave(req, res) {
  const payload = await parseJson(req);
  const domain = normalizeRecipeDomain(payload.domain || "");
  const recipe = sanitizeExtractionRecipe(payload.recipe);
  if (!domain || !recipe) {
    return sendJson(res, 422, {
      status: "validation_failed",
      errors: [!domain ? "domain is required." : "", !recipe ? "recipe with at least one field selector is required." : ""].filter(Boolean)
    });
  }
  const store = await readRecipesFile();
  const stamp = now();
  const existing = store.recipes.find((row) => row.domain === domain);
  const record = {
    id: existing?.id || randomUUID(),
    domain,
    recipe,
    model: String(payload.model || "").trim(),
    sample_url: String(payload.url || "").trim(),
    sample_lead_count: Number(payload.sample_lead_count) || 0,
    status: "active",
    stats: { runs: 0, leads: 0, consecutive_failures: 0 },
    created_at: existing?.created_at || stamp,
    updated_at: stamp
  };
  store.recipes = [...store.recipes.filter((row) => row.domain !== domain), record];

  const data = await readData();
  appendSystemLog(data, "info", "Extraction recipe saved", {
    actor_type: "llm",
    domain,
    model: record.model,
    sample_lead_count: record.sample_lead_count,
    replaced: Boolean(existing)
  });
  await writeData(data);
  await writeRecipesFile(store);
  await writeAiDebugReport("recipe-save", {
    domain,
    url: record.sample_url,
    model: record.model,
    lead_count: record.sample_lead_count,
    recipe: record.recipe,
    replaced_existing: Boolean(existing)
  });
  return sendJson(res, 200, { status: "saved", recipe: record });
}

async function handleRecipeFeedback(req, res) {
  const payload = await parseJson(req);
  const domain = normalizeRecipeDomain(payload.domain || "");
  const outcome = payload.status === "success" ? "success" : "failure";
  if (!domain) {
    return sendJson(res, 422, { status: "validation_failed", errors: ["domain is required."] });
  }
  const store = await readRecipesFile();
  const record = store.recipes.find((row) => row.domain === domain);
  if (!record) {
    return sendJson(res, 404, { status: "not_found", error: "No recipe for this domain." });
  }
  record.stats = record.stats || { runs: 0, leads: 0, consecutive_failures: 0 };
  record.stats.runs += 1;
  if (outcome === "success") {
    record.stats.leads += Number(payload.lead_count) || 0;
    record.stats.consecutive_failures = 0;
  } else {
    record.stats.consecutive_failures += 1;
    if (record.stats.consecutive_failures >= RECIPE_MAX_CONSECUTIVE_FAILURES) {
      record.status = "disabled";
    }
  }
  record.updated_at = now();
  await writeRecipesFile(store);

  if (outcome === "failure") {
    const data = await readData();
    appendSystemLog(data, record.status === "disabled" ? "warn" : "info", "Extraction recipe failure reported", {
      actor_type: "extension",
      domain,
      consecutive_failures: record.stats.consecutive_failures,
      disabled: record.status === "disabled"
    });
    await writeData(data);
    await writeAiDebugReport("recipe-run-failure", {
      domain,
      url: String(payload.url || "").slice(0, 500),
      recipe: record.recipe,
      stats: record.stats,
      disabled: record.status === "disabled"
    });
  }
  return sendJson(res, 200, { status: "recorded", recipe_status: record.status, stats: record.stats });
}

function parseLlmExtraction(content = "") {
  let text = String(content).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  if (start === -1 && arrayStart === -1) throw new Error("LLM returned no JSON.");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const sliceFrom = start !== -1 && (arrayStart === -1 || start < arrayStart) ? start : arrayStart;
    parsed = JSON.parse(text.slice(sliceFrom));
  }
  const rawLeads = Array.isArray(parsed) ? parsed : parsed.leads;
  if (!Array.isArray(rawLeads)) throw new Error("LLM JSON did not contain a leads array.");
  const leads = [];
  for (const raw of rawLeads) {
    if (!raw || typeof raw !== "object") continue;
    const lead = {
      name: String(raw.name || "").trim(),
      company_name: String(raw.company_name || raw.company || "").trim(),
      title: String(raw.title || "").trim(),
      emails: [...new Set((Array.isArray(raw.emails) ? raw.emails : [raw.email]).map(normalizeEmail).filter(Boolean))],
      phones: [...new Set((Array.isArray(raw.phones) ? raw.phones : [raw.phone]).map((value) => normalizePhone(String(value || ""))).filter(Boolean))],
      website: String(raw.website || "").trim(),
      address: String(raw.address || "").trim(),
      city: String(raw.city || "").trim(),
      record_kind: raw.record_kind === "company" ? "company" : "person",
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0))
    };
    if (!lead.name && !lead.company_name && !lead.emails.length && !lead.phones.length) continue;
    leads.push(lead);
  }
  const recipe = Array.isArray(parsed) ? null : sanitizeExtractionRecipe(parsed.recipe);
  return { leads, recipe };
}

async function handleAiExtract(req, res) {
  const payload = await parseJson(req);
  const url = String(payload.url || "").trim();
  const title = String(payload.title || "").trim();
  const pageText = String(payload.page_text || "").trim();
  const domSkeleton = String(payload.dom_skeleton || "").trim().slice(0, MAX_AI_DOM_SKELETON);
  const wantRecipe = payload.want_recipe === true;
  const previousRecipe = sanitizeExtractionRecipe(payload.previous_recipe);
  const contactLinks = (Array.isArray(payload.contact_links) ? payload.contact_links : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, 200);

  if (!pageText) {
    return sendJson(res, 422, { status: "validation_failed", errors: ["page_text is required."] });
  }

  const secrets = await readSecrets();
  const truncated = pageText.length > MAX_AI_PAGE_TEXT;
  const systemPrompt = wantRecipe
    ? `${AI_EXTRACT_SYSTEM_PROMPT}\n${AI_RECIPE_PROMPT_ADDENDUM}`
    : AI_EXTRACT_SYSTEM_PROMPT;
  const userMessage = [
    `URL: ${url || "(unknown)"}`,
    `Page title: ${title || "(none)"}`,
    contactLinks.length ? `Contact links found in the page HTML (mailto/tel/external):\n${contactLinks.join("\n")}` : "",
    wantRecipe && previousRecipe
      ? `A previously saved recipe for this site STOPPED WORKING (it now extracts nothing or garbage). Analyze why and produce a corrected recipe:\n${JSON.stringify(previousRecipe)}`
      : "",
    wantRecipe && domSkeleton
      ? `DOM skeleton (pruned HTML; repeated siblings collapsed; use these real classes/ids for recipe selectors):\n${domSkeleton}`
      : "",
    `Page text${truncated ? " (truncated)" : ""}:\n${pageText.slice(0, MAX_AI_PAGE_TEXT)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const startedAt = Date.now();
  const debugRequest = {
    url,
    title,
    want_recipe: wantRecipe,
    previous_recipe: previousRecipe,
    contact_links_count: contactLinks.length,
    contact_links_sample: contactLinks.slice(0, 20),
    page_text: debugSnippet(pageText),
    dom_skeleton: debugSnippet(domSkeleton),
    system_prompt: systemPrompt,
    user_message: debugSnippet(userMessage, 8000)
  };
  try {
    const result = await callLlmChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      secrets
    );
    const { leads, recipe } = parseLlmExtraction(result.content);
    const durationMs = Date.now() - startedAt;
    const data = await readData();
    appendSystemLog(data, "info", "AI lead extraction completed", {
      actor_type: "llm",
      source_url: url,
      model: result.model,
      lead_count: leads.length,
      recipe_returned: Boolean(recipe),
      duration_ms: durationMs,
      input_chars: pageText.length,
      truncated,
      usage: result.usage
    });
    await writeData(data);
    await writeAiDebugReport("ai-extract", {
      url,
      request: debugRequest,
      llm: {
        provider: secrets.llm.provider,
        model: result.model,
        duration_ms: durationMs,
        usage: result.usage,
        raw_content: result.content
      },
      parsed: {
        lead_count: leads.length,
        leads,
        recipe
      }
    });
    return sendJson(res, 200, {
      status: "ok",
      leads,
      recipe: wantRecipe ? recipe : null,
      model: result.model,
      usage: result.usage,
      truncated
    });
  } catch (error) {
    const data = await readData();
    appendSystemLog(data, "error", "AI lead extraction failed", {
      actor_type: "llm",
      source_url: url,
      model: secrets.llm.model,
      duration_ms: Date.now() - startedAt,
      error: error.message
    });
    await writeData(data);
    await writeAiDebugReport("ai-extract-error", {
      url,
      request: debugRequest,
      llm: {
        provider: secrets.llm.provider,
        model: secrets.llm.model,
        duration_ms: Date.now() - startedAt
      },
      error: error.message
    });
    return sendJson(res, 502, { status: "llm_failed", error: error.message });
  }
}

const QUERY_FIELDS = [
  "name",
  "title",
  "city",
  "website",
  "address",
  "email",
  "phone",
  "tag",
  "company",
  "source_platform",
  "review_status"
];
const QUERY_OPS = ["eq", "neq", "contains", "starts_with", "empty", "not_empty"];

function contactFieldValues(view, field) {
  switch (field) {
    case "name":
      return [view.name || ""];
    case "title":
      return [view.title || ""];
    case "city":
      return [view.city || ""];
    case "website":
      return [view.website || ""];
    case "address":
      return [view.address || ""];
    case "email":
      return view.emails || [];
    case "phone":
      return view.phones || [];
    case "tag":
      return view.tags || [];
    case "company":
      return [view.company?.name || ""];
    case "source_platform":
      return [view.source?.platform || view.source?.domain || ""];
    case "review_status":
      return [view.data_review_status || ""];
    default:
      return null;
  }
}

function contactMatchesFilter(view, filter) {
  const values = (contactFieldValues(view, filter.field) || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const needle = String(filter.value ?? "").trim().toLowerCase();
  switch (filter.op) {
    case "empty":
      return values.length === 0;
    case "not_empty":
      return values.length > 0;
    case "eq":
      return values.some((value) => value.toLowerCase() === needle);
    case "neq":
      return !values.some((value) => value.toLowerCase() === needle);
    case "contains":
      return values.some((value) => value.toLowerCase().includes(needle));
    case "starts_with":
      return values.some((value) => value.toLowerCase().startsWith(needle));
    default:
      return false;
  }
}

async function handleContactQuery(req, res) {
  const payload = await parseJson(req);
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const filters = Array.isArray(payload.filters) ? payload.filters : [];
  const match = payload.match === "any" ? "any" : "all";
  const errors = [];

  for (const [index, filter] of filters.entries()) {
    if (!QUERY_FIELDS.includes(filter?.field)) {
      errors.push(`filters[${index}].field must be one of: ${QUERY_FIELDS.join(", ")}.`);
    }
    if (!QUERY_OPS.includes(filter?.op)) {
      errors.push(`filters[${index}].op must be one of: ${QUERY_OPS.join(", ")}.`);
    }
    if (["eq", "neq", "contains", "starts_with"].includes(filter?.op) && !String(filter?.value ?? "").trim()) {
      errors.push(`filters[${index}].value is required for op "${filter?.op}".`);
    }
  }
  if (errors.length) {
    return sendJson(res, 422, { status: "validation_failed", errors });
  }

  const data = await readData();
  const rows = payload.include_deleted
    ? data.contacts.filter((row) => row.org_id === orgId)
    : activeRows(data.contacts, orgId);
  let contacts = rows.map((contact) => buildContactView(data, contact));

  if (payload.record_kind === "person" || payload.record_kind === "company") {
    contacts = contacts.filter((contact) => contact.record_kind === payload.record_kind);
  }
  if (filters.length) {
    contacts = contacts.filter((contact) =>
      match === "any"
        ? filters.some((filter) => contactMatchesFilter(contact, filter))
        : filters.every((filter) => contactMatchesFilter(contact, filter))
    );
  }

  const sortBy = payload.sort_by || "updated_at";
  contacts.sort((left, right) => {
    if (sortBy === "name") {
      return String(left.name || "").localeCompare(String(right.name || ""), "ar", { sensitivity: "base" });
    }
    if (sortBy === "city") {
      return String(left.city || "").localeCompare(String(right.city || ""), "ar", { sensitivity: "base" });
    }
    return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
  });

  const total = contacts.length;
  const limit = Math.max(1, Math.min(1000, Number(payload.limit) || 500));
  return sendJson(res, 200, {
    status: "ok",
    total,
    returned: Math.min(total, limit),
    contacts: contacts.slice(0, limit)
  });
}

function maskSecret(value = "") {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function splitContactName(fullName = "") {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function mapContactToGhlPayload(contactView, locationId) {
  const { firstName, lastName } = splitContactName(contactView.name || contactView.company?.name || "");
  const payload = {
    locationId,
    firstName,
    lastName,
    name: contactView.name || contactView.company?.name || "",
    companyName: contactView.company?.name || "",
    email: contactView.emails?.[0] || undefined,
    phone: contactView.phones?.[0] || undefined,
    website: contactView.website || undefined,
    address1: contactView.address || undefined,
    city: contactView.city || undefined,
    source: contactView.source?.platform || contactView.source?.domain || "AG CRM",
    tags: ["ag-crm", ...(contactView.tags || [])].slice(0, 20)
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === "") delete payload[key];
  }
  payload.locationId = locationId;
  return payload;
}

async function ghlRequest(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${GHL_BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      version: GHL_API_VERSION,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      responseBody.message ||
      (Array.isArray(responseBody.errors) ? responseBody.errors.join(" ") : "") ||
      `GoHighLevel request failed (HTTP ${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return responseBody;
}

async function handleGhlSettingsGet(res) {
  const secrets = await readSecrets();
  const ghl = secrets.gohighlevel;
  return sendJson(res, 200, {
    configured: Boolean(ghl.private_integration_token),
    token_preview: maskSecret(ghl.private_integration_token),
    default_location_id: ghl.default_location_id || "",
    locations: ghl.locations || []
  });
}

async function handleGhlSettingsSave(req, res) {
  const payload = await parseJson(req);
  const secrets = await readSecrets();
  const ghl = secrets.gohighlevel;
  if (payload.private_integration_token !== undefined) {
    ghl.private_integration_token = String(payload.private_integration_token || "").trim();
  }
  if (payload.default_location_id !== undefined) {
    ghl.default_location_id = String(payload.default_location_id || "").trim();
  }
  if (Array.isArray(payload.locations)) {
    ghl.locations = payload.locations
      .map((location) => ({
        id: String(location.id || "").trim(),
        label: String(location.label || location.name || "").trim()
      }))
      .filter((location) => location.id);
  }
  if (ghl.default_location_id && !(ghl.locations || []).some((location) => location.id === ghl.default_location_id)) {
    ghl.locations = [...(ghl.locations || []), { id: ghl.default_location_id, label: "" }];
  }
  await writeSecrets(secrets);
  const data = await readData();
  appendSystemLog(data, "info", "GoHighLevel settings updated", {
    actor_type: "human",
    configured: Boolean(ghl.private_integration_token),
    location_count: (ghl.locations || []).length
  });
  await writeData(data);
  return handleGhlSettingsGet(res);
}

async function handleGhlPush(req, res) {
  const payload = await parseJson(req);
  const contactIds = (Array.isArray(payload.contact_ids) ? payload.contact_ids : []).filter(Boolean);
  if (!contactIds.length) {
    return sendJson(res, 422, { status: "validation_failed", errors: ["contact_ids is required."] });
  }

  const secrets = await readSecrets();
  const token = secrets.gohighlevel.private_integration_token;
  if (!token) {
    return sendJson(res, 422, {
      status: "not_configured",
      errors: ["GoHighLevel token is not configured. Save it in Integrations first."]
    });
  }
  const locationId = String(payload.location_id || secrets.gohighlevel.default_location_id || "").trim();
  if (!locationId) {
    return sendJson(res, 422, {
      status: "validation_failed",
      errors: ["location_id is required (no default sub-account configured)."]
    });
  }

  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const results = [];
  const stamp = now();

  for (const contactId of contactIds) {
    const contact = activeRows(data.contacts, orgId).find((row) => row.id === contactId);
    if (!contact) {
      results.push({ contact_id: contactId, status: "failed", error: "Contact not found." });
      continue;
    }
    const view = buildContactView(data, contact);
    if (!view.emails?.length && !view.phones?.length) {
      results.push({
        contact_id: contactId,
        name: view.name || view.company?.name || "",
        status: "skipped",
        error: "No email or phone — GoHighLevel needs at least one."
      });
      continue;
    }
    try {
      const ghlPayload = mapContactToGhlPayload(view, locationId);
      const response = await ghlRequest("/contacts/upsert", { method: "POST", token, body: ghlPayload });
      const ghlContactId = response.contact?.id || response.id || "";
      contact.ghl_contact_id = ghlContactId || contact.ghl_contact_id || "";
      contact.ghl_pushed_at = stamp;
      contact.updated_at = stamp;
      contact.capture_metadata = {
        ...(contact.capture_metadata || {}),
        gohighlevel: {
          contact_id: ghlContactId,
          location_id: locationId,
          pushed_at: stamp
        }
      };
      data.activities.push({
        ...tenantRecord({ org_id: orgId }, "system"),
        contact_id: contact.id,
        type: "ghl_push",
        title: "Pushed to GoHighLevel",
        body: `Sub-account ${locationId}${ghlContactId ? ` · GHL contact ${ghlContactId}` : ""}`,
        occurred_at: stamp
      });
      results.push({
        contact_id: contactId,
        name: view.name || view.company?.name || "",
        status: response.new ? "created" : "updated",
        ghl_contact_id: ghlContactId
      });
    } catch (error) {
      results.push({
        contact_id: contactId,
        name: view.name || view.company?.name || "",
        status: "failed",
        error: error.message
      });
    }
  }

  const summary = {
    pushed: results.filter((row) => row.status === "created" || row.status === "updated").length,
    skipped: results.filter((row) => row.status === "skipped").length,
    failed: results.filter((row) => row.status === "failed").length
  };
  data.ingestion_events.unshift({
    ...tenantRecord({ org_id: orgId }, payload.actor_type || "human"),
    source: "gohighlevel",
    event_type: "export",
    status: summary.failed ? "completed_with_errors" : "completed",
    summary: `Pushed ${summary.pushed} of ${contactIds.length} contact(s) to GoHighLevel location ${locationId}.`,
    meta: { location_id: locationId, ...summary }
  });
  appendSystemLog(data, summary.failed ? "warn" : "info", "GoHighLevel push completed", {
    actor_type: payload.actor_type || "human",
    location_id: locationId,
    requested: contactIds.length,
    ...summary
  });
  await writeData(data);
  return sendJson(res, 200, { status: "completed", location_id: locationId, summary, results });
}

function normalizeEmail(value = "") {
  return value.trim().toLowerCase();
}

function normalizePhone(value = "") {
  const trimmed = value.trim();
  const leadingPlus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/[^\d]/g, "");
  return digits ? `${leadingPlus}${digits}` : "";
}

function sourceDomain(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function tenantRecord(input, actorType = "human") {
  const stamp = now();
  return {
    id: randomUUID(),
    org_id: input.org_id || DEFAULT_ORG_ID,
    created_by_user_id: input.created_by_user_id || DEFAULT_USER_ID,
    created_by_actor_type: actorType,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null
  };
}

function appendSystemLog(data, level, message, meta = {}) {
  data.system_logs.unshift({
    ...tenantRecord({ org_id: meta.org_id || DEFAULT_ORG_ID }, meta.actor_type || "system"),
    level,
    message,
    meta
  });
  data.system_logs = data.system_logs.slice(0, 500);
}

function activeRows(rows, orgId = DEFAULT_ORG_ID) {
  return rows.filter((row) => row.org_id === orgId && !row.deleted_at);
}

function findOrCreateCompany(data, name, orgId, actorType) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const existing = activeRows(data.companies, orgId).find(
    (company) => company.name.toLowerCase() === clean.toLowerCase()
  );
  if (existing) return existing;
  const company = {
    ...tenantRecord({ org_id: orgId }, actorType),
    name: clean,
    domain: ""
  };
  data.companies.push(company);
  return company;
}

function resolveContactCity(contact = {}, tagLabels = []) {
  const direct = String(contact.city || "").trim();
  if (direct) return direct;
  const ctx = contact.capture_metadata?.capture_context || {};
  if (ctx.city) return String(ctx.city).trim();
  for (const label of tagLabels) {
    if (String(label).toLowerCase().startsWith("city:")) {
      return String(label).slice(5).trim();
    }
  }
  return "";
}

function resolveContactCityInput(contactInput = {}, captureMetadata = null) {
  const direct = String(contactInput.city || "").trim();
  if (direct) return direct;
  const meta = contactInput.capture_metadata || captureMetadata || null;
  if (!meta) return "";
  return String(meta.capture_context?.city || "").trim();
}

function findOrCreateTag(data, label, orgId, actorType) {
  const clean = String(label || "").trim();
  if (!clean) return null;
  const existing = activeRows(data.tags, orgId).find(
    (tag) => tag.label.toLowerCase() === clean.toLowerCase()
  );
  if (existing) return existing;
  const tag = {
    ...tenantRecord({ org_id: orgId }, actorType),
    label: clean
  };
  data.tags.push(tag);
  return tag;
}

function attachTags(data, contactId, labels, orgId, actorType) {
  for (const label of labels || []) {
    const tag = findOrCreateTag(data, label, orgId, actorType);
    if (!tag) continue;
    const exists = activeRows(data.contact_tags, orgId).some(
      (row) => row.contact_id === contactId && row.tag_id === tag.id
    );
    if (!exists) {
      data.contact_tags.push({
        ...tenantRecord({ org_id: orgId }, actorType),
        contact_id: contactId,
        tag_id: tag.id
      });
    }
  }
}

function replaceTags(data, contactId, labels, orgId, actorType) {
  const stamp = now();
  for (const row of activeRows(data.contact_tags, orgId).filter((item) => item.contact_id === contactId)) {
    row.deleted_at = stamp;
    row.updated_at = stamp;
  }
  attachTags(data, contactId, labels, orgId, actorType);
}

function upsertContactMethods(data, contactId, emails = [], phones = [], orgId, actorType) {
  const desired = [
    ...emails.map((value) => ({ type: "email", value: normalizeEmail(value) })).filter((item) => item.value),
    ...phones.map((value) => ({ type: "phone", value: normalizePhone(value) })).filter((item) => item.value)
  ];
  for (const method of desired) {
    const exists = activeRows(data.contact_methods, orgId).some(
      (row) => row.contact_id === contactId && row.type === method.type && row.normalized_value === method.value
    );
    if (!exists) {
      data.contact_methods.push({
        ...tenantRecord({ org_id: orgId }, actorType),
        contact_id: contactId,
        type: method.type,
        value: method.value,
        normalized_value: method.value,
        is_primary: !activeRows(data.contact_methods, orgId).some(
          (row) => row.contact_id === contactId && row.type === method.type
        )
      });
    }
  }
}

function replaceContactMethods(data, contactId, emails = [], phones = [], orgId, actorType) {
  const stamp = now();
  for (const row of activeRows(data.contact_methods, orgId).filter((item) => item.contact_id === contactId)) {
    row.deleted_at = stamp;
    row.updated_at = stamp;
  }
  upsertContactMethods(data, contactId, emails, phones, orgId, actorType);
}

function findDuplicateContact(data, orgId, emails = [], phones = []) {
  const normalizedEmails = emails.map(normalizeEmail).filter(Boolean);
  const normalizedPhones = phones.map(normalizePhone).filter(Boolean);
  if (!normalizedEmails.length && !normalizedPhones.length) return null;

  const matches = activeRows(data.contact_methods, orgId).filter((method) => {
    if (method.type === "email") return normalizedEmails.includes(method.normalized_value);
    if (method.type === "phone") return normalizedPhones.includes(method.normalized_value);
    return false;
  });
  if (!matches.length) return null;
  return activeRows(data.contacts, orgId).find((contact) => contact.id === matches[0].contact_id) || null;
}

function normalizeSourceUrl(url = "") {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return String(url || "").trim().toLowerCase();
  }
}

function findContactBySourceUrl(data, orgId, sourceUrl = "") {
  const normalized = normalizeSourceUrl(sourceUrl);
  if (!normalized) return null;
  for (const source of activeRows(data.sources, orgId)) {
    if (normalizeSourceUrl(source.url) !== normalized) continue;
    const contact = activeRows(data.contacts, orgId).find((item) => item.id === source.contact_id);
    if (contact) return contact;
  }
  return null;
}

function normalizePersonNameForKind(raw = "") {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[A-Z]{2,3}\s+(?=[A-Za-z])/u, "");
}

function contactCompanyName(data, contact) {
  if (!contact?.company_id) return "";
  const company = (data.companies || []).find((item) => item.id === contact.company_id);
  return company?.name || "";
}

function nameLooksLikeCompany(name = "", companyName = "") {
  const normalized = String(name || "").trim();
  if (!normalized) return false;
  const company = String(companyName || "").trim().toLowerCase();
  const lower = normalized.toLowerCase();
  if (company && (lower === company || company.startsWith(lower) || lower.startsWith(company.split(" - ")[0]))) {
    return true;
  }
  return /\b(l\.?p\.?|llc|ltd|limited|inc|corp|corporation|branch|trading|law firm|company|co\.|group|international|holdings)\b/i.test(
    normalized
  );
}

function nameLooksLikePerson(name = "") {
  const normalized = normalizePersonNameForKind(name);
  if (!normalized) return false;
  if (nameLooksLikeCompany(normalized)) return false;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return false;
  return parts.every((part) => /^[\p{L}'-]+$/u.test(part));
}

function contactEntityKind(data, orgId, contact) {
  const ctx = contact?.capture_metadata?.capture_context || {};
  const ctxPerson = normalizePersonNameForKind(ctx.person_name || "");
  if (ctxPerson && nameLooksLikePerson(ctxPerson)) return "person";
  if (ctx.listing_tab === "people" && ctxPerson) return "person";

  const name = String(contact?.name || "").trim();
  const companyName = contactCompanyName(data, contact);
  if (nameLooksLikePerson(name)) return "person";
  if (nameLooksLikeCompany(name, companyName)) return "company";
  return "unknown";
}

function inferContactRecordKind(data, orgId, contact) {
  const name = String(contact?.name || "").trim();
  const ctx = contact?.capture_metadata?.capture_context || {};
  const ctxPerson = normalizePersonNameForKind(ctx.person_name || "");
  const companyName = contactCompanyName(data, contact);

  if (nameLooksLikePerson(name) && !nameLooksLikeCompany(name, companyName)) {
    return "person";
  }
  if (nameLooksLikeCompany(name, companyName)) {
    return "company";
  }
  if (contact.capture_metadata?.profile_page_type === "business") {
    return "company";
  }
  if (ctx.listing_tab === "people" && ctxPerson && nameLooksLikePerson(ctxPerson)) {
    return "person";
  }
  return "person";
}

function resolveContactRecordKind(data, orgId, contact) {
  return inferContactRecordKind(data, orgId, contact);
}

function resolveUpsertRecordKind(data, orgId, contactInput, payload) {
  if (contactInput.record_kind === "company" || contactInput.record_kind === "person") {
    return contactInput.record_kind;
  }
  const captureMetadata = contactInput.capture_metadata || payload.capture_metadata || null;
  const kind = incomingLeadEntityKind(data, orgId, {
    name: contactInput.name,
    company_name: contactInput.company_name,
    capture_metadata: captureMetadata
  });
  if (kind === "company" || kind === "person") return kind;
  return "person";
}

function refreshContactRecordKinds(data, orgId) {
  let updated = 0;
  const stamp = now();
  for (const contact of data.contacts) {
    if (contact.org_id !== orgId || contact.deleted_at) continue;
    const resolved = resolveContactRecordKind(data, orgId, contact);
    if (contact.record_kind === resolved) continue;
    contact.record_kind = resolved;
    contact.updated_at = stamp;
    updated += 1;
  }
  return updated;
}

function collapseDuplicateActivePeople(data, orgId, actorType = "system") {
  const groups = new Map();
  let merged = 0;

  for (const contact of activeRows(data.contacts, orgId)) {
    if (inferContactRecordKind(data, orgId, contact) !== "person") continue;
    const profileIds = contactProfileIds(data, contact, orgId);
    const nameKey = contact.name.trim().toLowerCase();
    if (!nameKey || !profileIds.length) continue;
    for (const profileId of profileIds) {
      const key = `${profileId}:${nameKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(contact);
    }
  }

  for (const contacts of groups.values()) {
    const unique = [...new Map(contacts.map((contact) => [contact.id, contact])).values()];
    if (unique.length < 2) continue;
    unique.sort((left, right) => dedupeContactScore(data, right) - dedupeContactScore(data, left));
    const keeper = unique[0];
    for (let index = 1; index < unique.length; index += 1) {
      mergeContactRecords(data, orgId, keeper, unique[index], actorType);
      merged += 1;
    }
  }

  return merged;
}

function incomingLeadEntityKind(
  data,
  orgId,
  { name = "", company_name = "", capture_metadata = null, person_name = "" } = {}
) {
  const ctx = capture_metadata?.capture_context || {};
  const ctxPerson = normalizePersonNameForKind(person_name || ctx.person_name || "");
  const normalizedName = String(name || "").trim();
  const companyName = company_name || ctx.company_name || "";

  if (nameLooksLikePerson(normalizedName) && !nameLooksLikeCompany(normalizedName, companyName)) {
    return "person";
  }
  if (nameLooksLikeCompany(normalizedName, companyName)) {
    return "company";
  }
  if (ctxPerson && nameLooksLikePerson(ctxPerson)) return "person";
  if (ctx.listing_tab === "people" && ctxPerson) return "person";
  if (capture_metadata?.profile_page_type === "business") return "company";
  return "unknown";
}

function contactMethodMatchCompatible(data, orgId, incoming, existingContact) {
  const incomingKind = incomingLeadEntityKind(data, orgId, incoming);
  const existingKind = contactEntityKind(data, orgId, existingContact);
  if (incomingKind === "unknown" || existingKind === "unknown") return true;
  return incomingKind === existingKind;
}

function profileUuidEntitiesCompatible(data, orgId, incoming, existingContact) {
  const incomingKind = incomingLeadEntityKind(data, orgId, incoming);
  const existingKind = contactEntityKind(data, orgId, existingContact);
  if (incomingKind === "unknown" || existingKind === "unknown") return true;
  if (incomingKind !== existingKind) return false;
  if (incomingKind === "person") {
    const incomingName = normalizePersonNameForKind(
      incoming.name || incoming.person_name || incoming.capture_metadata?.capture_context?.person_name || ""
    );
    const existingName = normalizePersonNameForKind(
      existingContact.name || existingContact.capture_metadata?.capture_context?.person_name || ""
    );
    if (incomingName && existingName && incomingName.toLowerCase() !== existingName.toLowerCase()) {
      return false;
    }
  }
  return true;
}

function contactsCompatibleForProfileMerge(data, orgId, keeper, duplicate) {
  return profileUuidEntitiesCompatible(
    data,
    orgId,
    { name: duplicate.name, capture_metadata: duplicate.capture_metadata },
    keeper
  );
}

function resolveExistingContactForUpsert(data, orgId, payload, emails, phones) {
  const contactInput = payload.contact || {};
  const incoming = {
    name: contactInput.name,
    company_name: contactInput.company_name,
    capture_metadata: contactInput.capture_metadata || payload.capture_metadata
  };

  const duplicateByMethod = findDuplicateContact(data, orgId, emails, phones);
  if (duplicateByMethod && contactMethodMatchCompatible(data, orgId, incoming, duplicateByMethod)) {
    return duplicateByMethod;
  }

  const duplicateBySourceUrl = findContactBySourceUrl(data, orgId, payload.source?.url || "");
  if (duplicateBySourceUrl && profileUuidEntitiesCompatible(data, orgId, incoming, duplicateBySourceUrl)) {
    return duplicateBySourceUrl;
  }

  const duplicateByProfileId = findContactByProfileId(data, orgId, payload.source?.url || "");
  if (duplicateByProfileId && profileUuidEntitiesCompatible(data, orgId, incoming, duplicateByProfileId)) {
    return duplicateByProfileId;
  }
  return null;
}

function findContactMatches(
  data,
  orgId,
  { source_url = "", emails = [], phones = [], name = "", person_name = "", company_name = "", capture_metadata = null } = {}
) {
  const matches = [];
  const seen = new Set();
  const incoming = { name, company_name, capture_metadata, person_name };

  const profileMatch = findContactByProfileId(data, orgId, source_url);
  if (profileMatch && profileUuidEntitiesCompatible(data, orgId, incoming, profileMatch)) {
    seen.add(profileMatch.id);
    matches.push({
      contact: buildContactView(data, profileMatch),
      match_type: "profile_id",
      match_reason: "This profile is already saved in the CRM."
    });
  }

  const sourceMatch = findContactBySourceUrl(data, orgId, source_url);
  if (sourceMatch && profileUuidEntitiesCompatible(data, orgId, incoming, sourceMatch) && !seen.has(sourceMatch.id)) {
    seen.add(sourceMatch.id);
    matches.push({
      contact: buildContactView(data, sourceMatch),
      match_type: "source_url",
      match_reason: "This profile URL is already saved in the CRM."
    });
  }
  const duplicate = findDuplicateContact(data, orgId, emails, phones);
  if (duplicate && contactMethodMatchCompatible(data, orgId, incoming, duplicate) && !seen.has(duplicate.id)) {
    seen.add(duplicate.id);
    matches.push({
      contact: buildContactView(data, duplicate),
      match_type: "email_or_phone",
      match_reason: "A contact with this email or phone already exists."
    });
  }

  if (name && matches.length === 0) {
    const normalizedName = name.trim().toLowerCase();
    const nameMatches = activeRows(data.contacts, orgId).filter(
      (contact) => contact.name.trim().toLowerCase() === normalizedName
    );
    for (const contact of nameMatches.slice(0, 3)) {
      if (seen.has(contact.id)) continue;
      seen.add(contact.id);
      matches.push({
        contact: buildContactView(data, contact),
        match_type: "name",
        match_reason: "A contact with this name already exists."
      });
    }
  }

  return matches;
}

function extractProfileUuid(url = "") {
  const match = String(url || "").match(/([0-9a-f-]{36})/i);
  return match ? match[1].toLowerCase() : "";
}

function findContactByProfileId(data, orgId, url = "") {
  const profileId = extractProfileUuid(url);
  if (!profileId) return null;
  for (const source of activeRows(data.sources, orgId)) {
    if (extractProfileUuid(source.url) !== profileId) continue;
    const contact = activeRows(data.contacts, orgId).find((item) => item.id === source.contact_id);
    if (contact) return contact;
  }
  for (const contact of activeRows(data.contacts, orgId)) {
    if (contactProfileIds(data, contact, orgId).includes(profileId)) return contact;
  }
  return null;
}

function contactProfileIds(data, contact, orgId) {
  const ids = new Set();
  for (const source of activeRows(data.sources, orgId)) {
    if (source.contact_id !== contact.id) continue;
    const profileId = extractProfileUuid(source.url);
    if (profileId) ids.add(profileId);
  }
  const ctx = contact.capture_metadata?.capture_context || {};
  for (const url of [ctx.company_profile_url, ctx.preferred_url, ctx.profile_url]) {
    const profileId = extractProfileUuid(url || "");
    if (profileId) ids.add(profileId);
  }
  return [...ids];
}

function buildProfileContactGroups(data, orgId) {
  const groups = new Map();
  for (const contact of activeRows(data.contacts, orgId)) {
    for (const profileId of contactProfileIds(data, contact, orgId)) {
      if (!groups.has(profileId)) groups.set(profileId, new Set());
      groups.get(profileId).add(contact.id);
    }
  }
  return groups;
}

function dedupeContactScore(data, contact) {
  const view = buildContactView(data, contact);
  const actorRank = { human: 60, extension: 50, hermes: 40, scraper: 10 };
  let score = actorRank[contact.created_by_actor_type] || 0;
  if (contact.data_review_status === "confirmed" && contact.data_reviewed_at) score += 40;
  score += view.emails.length * 8 + view.phones.length * 8;
  if (String(contact.name || "").trim()) score += 12;
  score += Date.parse(contact.updated_at || contact.created_at || 0) / 1e10;
  return score;
}

function mergeContactRecords(data, orgId, keeper, duplicate, actorType) {
  const stamp = now();
  const keeperView = buildContactView(data, keeper);
  const duplicateView = buildContactView(data, duplicate);

  if (dedupeContactScore(data, duplicate) > dedupeContactScore(data, keeper) + 5) {
    keeper.name = duplicate.name || keeper.name;
    keeper.title = duplicate.title || keeper.title;
    keeper.website = duplicate.website || keeper.website;
    keeper.address = duplicate.address || keeper.address;
    keeper.company_id = duplicate.company_id || keeper.company_id;
  } else {
    if (!String(keeper.name || "").trim() && duplicate.name) keeper.name = duplicate.name;
    if (!keeper.title && duplicate.title) keeper.title = duplicate.title;
    if (!keeper.website && duplicate.website) keeper.website = duplicate.website;
    if (!keeper.address && duplicate.address) keeper.address = duplicate.address;
    if (!keeper.company_id && duplicate.company_id) keeper.company_id = duplicate.company_id;
  }

  if (duplicate.data_review_status === "confirmed" && duplicate.data_reviewed_at) {
    keeper.data_review_status = "confirmed";
    keeper.data_reviewed_at = duplicate.data_reviewed_at;
    keeper.data_reviewed_by_actor_type = duplicate.data_reviewed_by_actor_type;
  }

  if (!keeper.capture_metadata && duplicate.capture_metadata) {
    keeper.capture_metadata = duplicate.capture_metadata;
  }

  upsertContactMethods(data, keeper.id, duplicateView.emails, duplicateView.phones, orgId, actorType);
  attachTags(data, keeper.id, duplicateView.tags, orgId, actorType);

  for (const collection of ["sources", "notes", "tasks", "activities", "files"]) {
    for (const row of data[collection] || []) {
      if (row.org_id !== orgId || row.contact_id !== duplicate.id || row.deleted_at) continue;
      row.contact_id = keeper.id;
      row.updated_at = stamp;
    }
  }

  for (const row of activeRows(data.contact_tags, orgId).filter((item) => item.contact_id === duplicate.id)) {
    const exists = activeRows(data.contact_tags, orgId).some(
      (item) => item.contact_id === keeper.id && item.tag_id === row.tag_id
    );
    if (exists) {
      row.deleted_at = stamp;
      row.updated_at = stamp;
    } else {
      row.contact_id = keeper.id;
      row.updated_at = stamp;
    }
  }

  duplicate.deleted_at = stamp;
  duplicate.updated_at = stamp;
  keeper.updated_at = stamp;
  keeper.last_activity_at = stamp;
}

function dedupeContactsByProfileId(data, orgId, actorType = "system") {
  const groups = buildProfileContactGroups(data, orgId);
  let merged = 0;
  const stamp = now();
  const removed = new Set();

  for (const [profileId, contactIds] of groups) {
    if (contactIds.size < 2) continue;
    const contacts = [...contactIds]
      .map((id) => activeRows(data.contacts, orgId).find((contact) => contact.id === id))
      .filter(Boolean)
      .filter((contact) => !contact.deleted_at && !removed.has(contact.id));
    if (contacts.length < 2) continue;

    contacts.sort((left, right) => dedupeContactScore(data, right) - dedupeContactScore(data, left));
    const keeper = contacts[0];
    let groupMerged = 0;
    for (let index = 1; index < contacts.length; index += 1) {
      const duplicate = contacts[index];
      if (duplicate.deleted_at || removed.has(duplicate.id) || duplicate.id === keeper.id) continue;
      if (!contactsCompatibleForProfileMerge(data, orgId, keeper, duplicate)) {
        continue;
      }
      mergeContactRecords(data, orgId, keeper, duplicate, actorType);
      removed.add(duplicate.id);
      merged += 1;
      groupMerged += 1;
    }

    if (groupMerged > 0) {
      data.activities.push({
        ...tenantRecord({ org_id: orgId }, actorType),
        contact_id: keeper.id,
        type: "contact_merged",
        title: "Duplicate contacts merged",
        body: `Merged ${groupMerged} duplicate record(s) for profile ${profileId}.`,
        occurred_at: stamp
      });
    }
  }

  if (merged > 0) {
    appendSystemLog(data, "info", "Contact dedupe completed", {
      org_id: orgId,
      actor_type: actorType,
      merged
    });
  }

  return { merged, groups_scanned: groups.size };
}

function resolveReviewStatus(contact = {}) {
  if (contact.data_review_status === "confirmed" && contact.data_reviewed_at) return "confirmed";
  if (contact.data_review_status === "pending") return "pending";
  if (contact.created_by_actor_type === "scraper") return "pending";
  return "unreviewed";
}

function buildContactView(data, contact) {
  const orgId = contact.org_id;
  const company = contact.company_id
    ? data.companies.find((item) => item.id === contact.company_id)
    : null;
  const methods = activeRows(data.contact_methods, orgId).filter((method) => method.contact_id === contact.id);
  const tagIds = activeRows(data.contact_tags, orgId)
    .filter((row) => row.contact_id === contact.id)
    .map((row) => row.tag_id);
  const tags = activeRows(data.tags, orgId).filter((tag) => tagIds.includes(tag.id));
  const notes = activeRows(data.notes, orgId).filter((note) => note.contact_id === contact.id);
  const tasks = activeRows(data.tasks, orgId).filter((task) => task.contact_id === contact.id);
  const activities = activeRows(data.activities, orgId).filter((activity) => activity.contact_id === contact.id);
  const source = contact.source_id ? data.sources.find((item) => item.id === contact.source_id) : null;
  const files = activeRows(data.files, orgId)
    .filter((file) => file.contact_id === contact.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    ...contact,
    record_kind: resolveContactRecordKind(data, orgId, contact),
    data_review_status: resolveReviewStatus(contact),
    company,
    city: resolveContactCity(contact, tags.map((tag) => tag.label)),
    emails: methods.filter((method) => method.type === "email").map((method) => method.value),
    phones: methods.filter((method) => method.type === "phone").map((method) => method.value),
    tags: tags.map((tag) => tag.label),
    notes: notes.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    tasks: tasks.sort((a, b) => String(a.due_at || "").localeCompare(String(b.due_at || ""))),
    activities: activities.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    source,
    files
  };
}

function searchContacts(data, q = "", orgId = DEFAULT_ORG_ID, filters = {}) {
  const query = q.trim().toLowerCase();
  const rows = filters.include_deleted
    ? data.contacts.filter((row) => row.org_id === orgId)
    : activeRows(data.contacts, orgId);
  let contacts = rows.map((contact) => buildContactView(data, contact));
  if (filters.record_kind === "person" || filters.record_kind === "company") {
    contacts = contacts.filter((contact) => contact.record_kind === filters.record_kind);
  }
  if (filters.review_status) {
    contacts = contacts.filter((contact) => resolveReviewStatus(contact) === filters.review_status);
  }
  const sortBy = filters.sort_by || "updated_at";
  const sortContacts = (left, right) => {
    if (Boolean(left.deleted_at) !== Boolean(right.deleted_at)) {
      return left.deleted_at ? 1 : -1;
    }
    if (sortBy === "name") {
      return String(left.name || "").localeCompare(String(right.name || ""), "ar", { sensitivity: "base" });
    }
    if (sortBy === "city") {
      return String(left.city || "").localeCompare(String(right.city || ""), "ar", { sensitivity: "base" });
    }
    return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
  };
  if (!query) {
    return contacts.sort(sortContacts);
  }
  return contacts
    .filter((contact) => {
    const haystack = [
      contact.name,
      contact.title,
      contact.city,
      contact.company?.name,
      contact.website,
      contact.address,
      contact.emails.join(" "),
      contact.phones.join(" "),
      contact.tags.join(" "),
      contact.source?.url,
      contact.source?.domain
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  })
    .sort(sortContacts);
}

async function parseJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body));
}

function sendError(res, statusCode, message, errors = []) {
  sendJson(res, statusCode, { error: message, errors });
}

function runContactCleanup(data, orgId, actorType = "system") {
  const recordKindsUpdated = refreshContactRecordKinds(data, orgId);
  const dedupeResult = dedupeContactsByProfileId(data, orgId, actorType);
  const peopleMerged = collapseDuplicateActivePeople(data, orgId, actorType);
  refreshContactRecordKinds(data, orgId);
  return {
    ...dedupeResult,
    merged: dedupeResult.merged + peopleMerged,
    people_merged: peopleMerged,
    record_kinds_updated: recordKindsUpdated
  };
}

async function handleContactUpsert(req, res) {
  const payload = await parseJson(req);
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "human";
  const contactInput = payload.contact || {};
  const emails = contactInput.emails || [];
  const phones = contactInput.phones || [];
  const errors = [];

  if (!String(contactInput.name || "").trim() && !emails.length && !phones.length) {
    errors.push("Provide at least a name, email, or phone.");
  }
  if (errors.length) {
    appendSystemLog(data, "warn", "Contact upsert validation failed", { org_id: orgId, actor_type: actorType, errors });
    await writeData(data);
    return sendJson(res, 422, { status: "validation_failed", errors });
  }

  const company = findOrCreateCompany(data, contactInput.company_name, orgId, actorType);
  const duplicate = resolveExistingContactForUpsert(data, orgId, payload, emails, phones);
  const recordKind = resolveUpsertRecordKind(data, orgId, contactInput, payload);
  const captureMetadata = contactInput.capture_metadata || payload.capture_metadata || null;
  const city = resolveContactCityInput(contactInput, captureMetadata);
  const stamp = now();
  let contact = duplicate;
  let status = "updated";

  if (!contact) {
    contact = {
      ...tenantRecord({ org_id: orgId }, actorType),
      name: String(contactInput.name || "").trim(),
      title: String(contactInput.title || "").trim(),
      city,
      website: String(contactInput.website || "").trim(),
      address: String(contactInput.address || "").trim(),
      company_id: company?.id || null,
      record_kind: recordKind,
      source_id: null,
      last_activity_at: stamp,
      data_review_status:
        contactInput.data_review_status ||
        payload.data_review_status ||
        (actorType === "scraper" ? "pending" : "confirmed"),
      data_reviewed_at: null,
      data_reviewed_by_actor_type: null,
      capture_metadata: captureMetadata
    };
    data.contacts.push(contact);
    status = "created";
  } else {
    contact.name = String(contactInput.name || contact.name || "").trim();
    contact.title = String(contactInput.title || contact.title || "").trim();
    if (contactInput.city !== undefined || city) {
      contact.city = city || String(contactInput.city || contact.city || "").trim();
    }
    if (contactInput.website !== undefined) contact.website = String(contactInput.website || "").trim();
    if (contactInput.address !== undefined) contact.address = String(contactInput.address || "").trim();
    contact.company_id = company?.id || contact.company_id || null;
    contact.record_kind = recordKind;
    contact.updated_at = stamp;
    contact.last_activity_at = stamp;
    if (contactInput.capture_metadata || payload.capture_metadata) {
      contact.capture_metadata = contactInput.capture_metadata || payload.capture_metadata;
    }
    if (actorType === "scraper") {
      contact.data_review_status = "pending";
      contact.data_reviewed_at = null;
      contact.data_reviewed_by_actor_type = null;
    }
  }

  let source = null;
  if (payload.source?.url) {
    source = {
      ...tenantRecord({ org_id: orgId }, actorType),
      contact_id: contact.id,
      url: payload.source.url,
      domain: payload.source.domain || sourceDomain(payload.source.url),
      platform: payload.source.platform || payload.source.domain || sourceDomain(payload.source.url),
      captured_at: payload.source.captured_at || stamp
    };
    data.sources.push(source);
    contact.source_id = source.id;
  }

  upsertContactMethods(data, contact.id, emails, phones, orgId, actorType);
  attachTags(data, contact.id, contactInput.tags || [], orgId, actorType);

  const activity = {
    ...tenantRecord({ org_id: orgId }, actorType),
    contact_id: contact.id,
    type: status === "created" ? "contact_created" : "contact_updated",
    title: status === "created" ? "Contact created" : "Contact updated",
    body: contactInput.note || "",
    occurred_at: stamp
  };
  data.activities.push(activity);

  if (contactInput.note) {
    data.notes.push({
      ...tenantRecord({ org_id: orgId }, actorType),
      contact_id: contact.id,
      body: contactInput.note
    });
  }

  appendSystemLog(data, "info", `Contact ${status}`, {
    org_id: orgId,
    actor_type: actorType,
    contact_id: contact.id,
    source_url: payload.source?.url || null
  });

  if (actorType === "hermes") {
    data.agent_actions.unshift({
      ...tenantRecord({ org_id: orgId }, "hermes"),
      command: payload.command || "contacts.upsert",
      tool_name: "contacts.upsert",
      input_json: payload,
      output_json: { status, contact_id: contact.id },
      status: "succeeded",
      error_message: "",
      created_record_ids: [contact.id],
      started_at: stamp,
      completed_at: now()
    });
  }

  const cleanup = runContactCleanup(data, orgId, actorType);

  await writeData(data);
  sendJson(res, 200, {
    status,
    contact_id: contact.id,
    company_id: company?.id || null,
    duplicate_contact_id: duplicate?.id || null,
    activity_id: activity.id,
    source_id: source?.id || null,
    dedupe: cleanup
  });
}

async function handleContactUpdate(req, res, contactId) {
  const payload = await parseJson(req);
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "human";
  const contactInput = payload.contact || {};
  const emails = contactInput.emails || [];
  const phones = contactInput.phones || [];
  const contact = activeRows(data.contacts, orgId).find((item) => item.id === contactId);
  const errors = [];

  if (!contact) errors.push("Contact not found.");
  if (!String(contactInput.name || "").trim() && !emails.length && !phones.length) {
    errors.push("Provide at least a name, email, or phone.");
  }

  const duplicate = findDuplicateContact(data, orgId, emails, phones);
  if (duplicate && duplicate.id !== contactId) {
    errors.push("Another contact already uses this email or phone.");
  }

  if (errors.length) {
    appendSystemLog(data, "warn", "Contact update validation failed", {
      org_id: orgId,
      actor_type: actorType,
      contact_id: contactId,
      errors
    });
    await writeData(data);
    return sendJson(res, contact ? 422 : 404, { status: "validation_failed", errors });
  }

  const stamp = now();
  const company = findOrCreateCompany(data, contactInput.company_name, orgId, actorType);
  contact.name = String(contactInput.name || "").trim();
  contact.title = String(contactInput.title || "").trim();
  if (contactInput.city !== undefined) contact.city = String(contactInput.city || "").trim();
  contact.website = String(contactInput.website || "").trim();
  contact.address = String(contactInput.address || "").trim();
  contact.company_id = company?.id || null;
  contact.updated_at = stamp;
  contact.last_activity_at = stamp;

  replaceContactMethods(data, contact.id, emails, phones, orgId, actorType);
  replaceTags(data, contact.id, contactInput.tags || [], orgId, actorType);

  let source = null;
  if (payload.source?.url) {
    source = contact.source_id ? data.sources.find((item) => item.id === contact.source_id) : null;
    if (source) {
      source.url = payload.source.url;
      source.domain = payload.source.domain || sourceDomain(payload.source.url);
      source.platform = payload.source.platform || payload.source.domain || sourceDomain(payload.source.url);
      source.captured_at = payload.source.captured_at || source.captured_at || stamp;
      source.updated_at = stamp;
    } else {
      source = {
        ...tenantRecord({ org_id: orgId }, actorType),
        contact_id: contact.id,
        url: payload.source.url,
        domain: payload.source.domain || sourceDomain(payload.source.url),
        platform: payload.source.platform || payload.source.domain || sourceDomain(payload.source.url),
        captured_at: payload.source.captured_at || stamp
      };
      data.sources.push(source);
      contact.source_id = source.id;
    }
  }

  const activity = {
    ...tenantRecord({ org_id: orgId }, actorType),
    contact_id: contact.id,
    type: "contact_edited",
    title: "Contact edited",
    body: contactInput.change_note || "",
    occurred_at: stamp
  };
  data.activities.push(activity);

  appendSystemLog(data, "info", "Contact edited", {
    org_id: orgId,
    actor_type: actorType,
    contact_id: contact.id
  });

  await writeData(data);
  sendJson(res, 200, {
    status: "updated",
    contact_id: contact.id,
    company_id: company?.id || null,
    activity_id: activity.id,
    source_id: source?.id || contact.source_id || null,
    contact: buildContactView(data, contact)
  });
}

async function handleContactReview(req, res, contactId) {
  const payload = await parseJson(req);
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "human";
  const contact = activeRows(data.contacts, orgId).find((item) => item.id === contactId);
  if (!contact) return sendError(res, 404, "Contact not found.");

  const stamp = now();
  contact.data_review_status = payload.status === "pending" ? "pending" : "confirmed";
  if (contact.data_review_status === "confirmed") {
    contact.data_reviewed_at = stamp;
    contact.data_reviewed_by_actor_type = actorType;
  } else {
    contact.data_reviewed_at = null;
    contact.data_reviewed_by_actor_type = null;
  }
  contact.updated_at = stamp;

  data.activities.push({
    ...tenantRecord({ org_id: orgId }, actorType),
    contact_id: contact.id,
    type: "data_review",
    title: contact.data_review_status === "confirmed" ? "Data confirmed" : "Marked for review",
    body: payload.note || "",
    occurred_at: stamp
  });

  appendSystemLog(data, "info", "Contact review status updated", {
    org_id: orgId,
    actor_type: actorType,
    contact_id: contact.id,
    data_review_status: contact.data_review_status
  });

  await writeData(data);
  sendJson(res, 200, {
    status: "updated",
    contact_id: contact.id,
    data_review_status: contact.data_review_status,
    contact: buildContactView(data, contact)
  });
}

async function handleContactFileUpload(req, res, contactId) {
  const payload = await parseJson(req);
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "scraper";
  const contact = activeRows(data.contacts, orgId).find((item) => item.id === contactId);
  if (!contact) return sendError(res, 404, "Contact not found.");

  const filename = String(payload.filename || "attachment.pdf").trim() || "attachment.pdf";
  const mimeType = String(payload.mime_type || "application/pdf").trim() || "application/pdf";
  const sourceUrl = String(payload.source_url || "").trim();
  const kind = String(payload.kind || "brochure").trim() || "brochure";
  const contentBase64 = String(payload.content_base64 || "");
  if (!contentBase64) return sendError(res, 422, "content_base64 is required.");

  let buffer;
  try {
    buffer = Buffer.from(contentBase64, "base64");
  } catch {
    return sendError(res, 422, "Invalid base64 content.");
  }
  if (!buffer.length) return sendError(res, 422, "Empty file content.");
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    return sendError(res, 422, `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes.`);
  }

  const fileId = randomUUID();
  const safeName = basename(filename).replace(/[^\w.\-() ]+/g, "_");
  const orgDir = join(ATTACHMENTS_DIR, orgId);
  await mkdir(orgDir, { recursive: true });
  const storedName = `${fileId}_${safeName}`;
  const storedPath = join(orgDir, storedName);
  await writeFile(storedPath, buffer);

  const record = {
    ...tenantRecord({ org_id: orgId }, actorType),
    contact_id: contact.id,
    kind,
    filename: safeName,
    mime_type: mimeType,
    size_bytes: buffer.length,
    source_url: sourceUrl,
    stored_path: join("attachments", orgId, storedName),
    content_hash: String(payload.content_hash || "").trim()
  };
  data.files.push(record);

  data.activities.push({
    ...tenantRecord({ org_id: orgId }, actorType),
    contact_id: contact.id,
    type: "file_attached",
    title: `Attachment added: ${safeName}`,
    body: sourceUrl || kind,
    occurred_at: now()
  });

  appendSystemLog(data, "info", "Contact file attached", {
    org_id: orgId,
    actor_type: actorType,
    contact_id: contact.id,
    file_id: record.id,
    filename: safeName,
    size_bytes: buffer.length
  });

  await writeData(data);
  sendJson(res, 201, { status: "created", file: record });
}

async function handleContactDelete(req, res, contactId) {
  const payload = await parseJson(req).catch(() => ({}));
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "human";
  const contact = activeRows(data.contacts, orgId).find((item) => item.id === contactId);
  if (!contact) return sendError(res, 404, "Contact not found.");

  const stamp = now();
  contact.deleted_at = stamp;
  contact.updated_at = stamp;

  data.activities.push({
    ...tenantRecord({ org_id: orgId }, actorType),
    contact_id: contact.id,
    type: "contact_deleted",
    title: "Contact removed",
    body: payload.note || "Removed from CRM.",
    occurred_at: stamp
  });

  appendSystemLog(data, "info", "Contact deleted", {
    org_id: orgId,
    actor_type: actorType,
    contact_id: contact.id
  });

  await writeData(data);
  sendJson(res, 200, { status: "deleted", contact_id: contact.id });
}

async function handleDedupeContacts(req, res) {
  const payload = await parseJson(req).catch(() => ({}));
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "human";
  const cleanup = runContactCleanup(data, orgId, actorType);
  appendSystemLog(data, "info", "Contact dedupe completed", {
    org_id: orgId,
    actor_type: actorType,
    merged: cleanup.merged,
    people_merged: cleanup.people_merged,
    record_kinds_updated: cleanup.record_kinds_updated
  });
  await writeData(data);
  sendJson(res, 200, { status: "deduped", ...cleanup });
}

async function handleRestoreDeletedContacts(req, res) {
  const payload = await parseJson(req).catch(() => ({}));
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "human";
  const scope = payload.scope || "all";
  const stamp = now();
  let restored = 0;

  for (const contact of data.contacts) {
    if (contact.org_id !== orgId || !contact.deleted_at) continue;
    if (scope === "scraper" && contact.created_by_actor_type !== "scraper") continue;
    contact.deleted_at = null;
    contact.updated_at = stamp;
    restored += 1;
  }

  appendSystemLog(data, "info", "Restored deleted contacts", {
    org_id: orgId,
    actor_type: actorType,
    scope,
    restored
  });
  await writeData(data);
  sendJson(res, 200, { status: "restored", restored });
}

async function handleBulkDeleteContacts(req, res) {
  const payload = await parseJson(req);
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "human";
  const ids = Array.isArray(payload.contact_ids) ? payload.contact_ids.filter(Boolean) : [];
  if (!ids.length) return sendError(res, 422, "contact_ids is required.");

  const stamp = now();
  let deleted = 0;
  const idSet = new Set(ids);

  for (const contact of data.contacts) {
    if (contact.org_id !== orgId || contact.deleted_at || !idSet.has(contact.id)) continue;
    contact.deleted_at = stamp;
    contact.updated_at = stamp;
    deleted += 1;
  }

  appendSystemLog(data, "info", "Bulk deleted selected contacts", {
    org_id: orgId,
    actor_type: actorType,
    deleted,
    requested: ids.length
  });
  await writeData(data);
  sendJson(res, 200, { status: "deleted", deleted, requested: ids.length });
}

async function handleFileDownload(req, res, fileId) {
  const data = await readData();
  const file = activeRows(data.files).find((item) => item.id === fileId);
  if (!file) return sendError(res, 404, "File not found.");

  const filePath = join(DATA_DIR, file.stored_path || "");
  if (!filePath.startsWith(ATTACHMENTS_DIR) || !existsSync(filePath)) {
    return sendError(res, 404, "File content missing.");
  }

  const body = await readFile(filePath);
  res.writeHead(200, {
    "content-type": file.mime_type || "application/octet-stream",
    "content-disposition": `inline; filename="${file.filename || "attachment.pdf"}"`,
    "access-control-allow-origin": "*"
  });
  res.end(body);
}

async function createChildRecord(req, res, collection, requiredFields) {
  const payload = await parseJson(req);
  const data = await readData();
  const orgId = payload.org_id || DEFAULT_ORG_ID;
  const actorType = payload.actor_type || "human";
  const errors = requiredFields
    .filter((field) => !String(payload[field] || "").trim())
    .map((field) => `${field} is required.`);

  if (errors.length) {
    appendSystemLog(data, "warn", `${collection} validation failed`, { org_id: orgId, actor_type: actorType, errors });
    await writeData(data);
    return sendJson(res, 422, { status: "validation_failed", errors });
  }

  const record = {
    ...tenantRecord({ org_id: orgId }, actorType),
    ...payload
  };
  data[collection].push(record);

  if (payload.contact_id && collection !== "activities") {
    data.activities.push({
      ...tenantRecord({ org_id: orgId }, actorType),
      contact_id: payload.contact_id,
      type: collection.slice(0, -1) || collection,
      title: collection === "tasks" ? `Task: ${payload.title}` : `Added ${collection.slice(0, -1)}`,
      body: payload.body || payload.description || "",
      occurred_at: now()
    });
  }

  appendSystemLog(data, "info", `${collection} created`, {
    org_id: orgId,
    actor_type: actorType,
    record_id: record.id,
    contact_id: payload.contact_id || null
  });

  await writeData(data);
  sendJson(res, 201, { status: "created", record });
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  if (req.method === "GET" && pathname === "/api/health") {
    const data = await readData();
    const activeRowsList = activeRows(data.contacts);
    const activeContacts = activeRowsList.length;
    const deletedContacts = data.contacts.filter((row) => row.deleted_at).length;
    const peopleCount = activeRowsList.filter(
      (contact) => resolveContactRecordKind(data, contact.org_id, contact) === "person"
    ).length;
    const companyProfileCount = activeRowsList.filter(
      (contact) => resolveContactRecordKind(data, contact.org_id, contact) === "company"
    ).length;
    return sendJson(res, 200, {
      status: "ok",
      service: "ag-crm",
      storage: "json-file",
      time: now(),
      counts: {
        contacts: activeContacts,
        people: peopleCount,
        company_profiles: companyProfileCount,
        contacts_deleted: deletedContacts,
        contacts_total: data.contacts.length,
        activities: activeRows(data.activities).length,
        system_logs: data.system_logs.length
      }
    });
  }

  if (req.method === "GET" && pathname === "/api/contacts") {
    const data = await readData();
    return sendJson(res, 200, {
      contacts: searchContacts(data, searchParams.get("q") || "", DEFAULT_ORG_ID, {
        review_status: searchParams.get("review_status") || "",
        include_deleted: searchParams.get("include_deleted") === "1",
        record_kind: searchParams.get("record_kind") || "",
        sort_by: searchParams.get("sort_by") || "updated_at"
      })
    });
  }

  if (req.method === "POST" && pathname === "/api/contacts/query") {
    return handleContactQuery(req, res);
  }

  if (req.method === "POST" && pathname === "/api/extract/ai") {
    return handleAiExtract(req, res);
  }

  if (req.method === "GET" && pathname === "/api/extract/debug") {
    return handleAiDebugList(res, searchParams);
  }

  if (req.method === "POST" && pathname === "/api/extract/debug/client") {
    return handleAiDebugClientEvent(req, res);
  }

  if (req.method === "GET" && pathname === "/api/extract/recipes") {
    return handleRecipeGet(res, searchParams);
  }

  if (req.method === "POST" && pathname === "/api/extract/recipes") {
    return handleRecipeSave(req, res);
  }

  if (req.method === "POST" && pathname === "/api/extract/recipes/feedback") {
    return handleRecipeFeedback(req, res);
  }

  if (req.method === "GET" && pathname === "/api/integrations/gohighlevel") {
    return handleGhlSettingsGet(res);
  }

  if (req.method === "POST" && pathname === "/api/integrations/gohighlevel") {
    return handleGhlSettingsSave(req, res);
  }

  if (req.method === "POST" && pathname === "/api/integrations/gohighlevel/push") {
    return handleGhlPush(req, res);
  }

  if (req.method === "GET" && pathname === "/api/contacts/match") {
    const data = await readData();
    const orgId = searchParams.get("org_id") || DEFAULT_ORG_ID;
    const emails = (searchParams.get("emails") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const phones = (searchParams.get("phones") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    let captureMetadata = null;
    const captureMetadataRaw = searchParams.get("capture_metadata") || "";
    if (captureMetadataRaw) {
      try {
        captureMetadata = JSON.parse(captureMetadataRaw);
      } catch {
        captureMetadata = null;
      }
    }
    const matches = findContactMatches(data, orgId, {
      source_url: searchParams.get("source_url") || "",
      emails,
      phones,
      name: searchParams.get("name") || "",
      person_name: searchParams.get("person_name") || "",
      company_name: searchParams.get("company_name") || "",
      capture_metadata: captureMetadata
    });
    appendSystemLog(data, "info", "Contact match lookup", {
      org_id: orgId,
      actor_type: searchParams.get("actor_type") || "extension",
      source_url: searchParams.get("source_url") || null,
      match_count: matches.length,
      profile_entity_mismatch_skipped: Boolean(
        searchParams.get("source_url") &&
          extractProfileUuid(searchParams.get("source_url")) &&
          matches.every((match) => match.match_type !== "profile_id")
      )
    });
    await writeData(data);
    return sendJson(res, 200, {
      exists: matches.length > 0,
      matches,
      best_match: matches[0] || null
    });
  }

  if (req.method === "POST" && pathname === "/api/contacts/bulk-delete") {
    return handleBulkDeleteContacts(req, res);
  }

  if (req.method === "POST" && pathname === "/api/contacts/restore-deleted") {
    return handleRestoreDeletedContacts(req, res);
  }

  if (req.method === "POST" && pathname === "/api/contacts/dedupe") {
    return handleDedupeContacts(req, res);
  }

  if (req.method === "GET" && pathname.startsWith("/api/files/") && pathname.endsWith("/download")) {
    const fileId = pathname.split("/")[3];
    return handleFileDownload(req, res, fileId);
  }

  if (req.method === "POST" && pathname.startsWith("/api/contacts/") && pathname.endsWith("/review")) {
    const contactId = pathname.split("/")[3];
    return handleContactReview(req, res, contactId);
  }

  if (req.method === "POST" && pathname.startsWith("/api/contacts/") && pathname.endsWith("/files")) {
    const contactId = pathname.split("/")[3];
    return handleContactFileUpload(req, res, contactId);
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/contacts/")) {
    const contactId = pathname.split("/")[3];
    if (!contactId || contactId.includes("/")) return sendError(res, 404, "API route not found.");
    return handleContactDelete(req, res, contactId);
  }

  if (req.method === "GET" && pathname.startsWith("/api/contacts/")) {
    const contactId = pathname.split("/")[3];
    const data = await readData();
    const contact = activeRows(data.contacts).find((item) => item.id === contactId);
    if (!contact) return sendError(res, 404, "Contact not found.");
    return sendJson(res, 200, { contact: buildContactView(data, contact) });
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/contacts/")) {
    const contactId = pathname.split("/")[3];
    if (!contactId || contactId.includes("/")) return sendError(res, 404, "API route not found.");
    return handleContactUpdate(req, res, contactId);
  }

  if (req.method === "GET" && pathname === "/api/search") {
    const data = await readData();
    return sendJson(res, 200, { contacts: searchContacts(data, searchParams.get("q") || "") });
  }

  if (req.method === "POST" && pathname === "/api/contacts/upsert") {
    return handleContactUpsert(req, res);
  }

  if (req.method === "POST" && pathname === "/api/tasks") {
    return createChildRecord(req, res, "tasks", ["contact_id", "title"]);
  }

  if (req.method === "POST" && pathname === "/api/notes") {
    return createChildRecord(req, res, "notes", ["contact_id", "body"]);
  }

  if (req.method === "POST" && pathname === "/api/activities") {
    return createChildRecord(req, res, "activities", ["contact_id", "title"]);
  }

  if (req.method === "GET" && pathname === "/api/agent/logs") {
    const data = await readData();
    return sendJson(res, 200, {
      agent_actions: data.agent_actions.slice(0, 100),
      system_logs: data.system_logs.slice(0, 100)
    });
  }

  if (req.method === "POST" && pathname === "/api/agent/actions") {
    const payload = await parseJson(req);
    const data = await readData();
    const record = {
      ...tenantRecord({ org_id: payload.org_id || DEFAULT_ORG_ID }, "hermes"),
      command: payload.command || "",
      tool_name: payload.tool_name || "manual",
      input_json: payload.input_json || {},
      output_json: payload.output_json || {},
      status: payload.status || "started",
      error_message: payload.error_message || "",
      created_record_ids: payload.created_record_ids || [],
      started_at: payload.started_at || now(),
      completed_at: payload.completed_at || null
    };
    data.agent_actions.unshift(record);
    await writeData(data);
    return sendJson(res, 201, { status: "created", record });
  }

  if (req.method === "GET" && pathname === "/api/ingestion-events") {
    const data = await readData();
    return sendJson(res, 200, { ingestion_events: data.ingestion_events.slice(0, 100) });
  }

  if (req.method === "POST" && pathname === "/api/ingestion-events") {
    const payload = await parseJson(req);
    const data = await readData();
    const orgId = payload.org_id || DEFAULT_ORG_ID;
    const actorType = payload.actor_type || "scraper";
    const record = {
      ...tenantRecord({ org_id: orgId }, actorType),
      source: String(payload.source || "").trim(),
      event_type: String(payload.event_type || "scrape").trim(),
      status: String(payload.status || "completed").trim(),
      summary: String(payload.summary || "").trim(),
      meta: payload.meta || {}
    };
    data.ingestion_events.unshift(record);
    appendSystemLog(data, "info", "Ingestion event recorded", {
      org_id: orgId,
      actor_type: actorType,
      event_type: record.event_type,
      source: record.source
    });
    await writeData(data);
    return sendJson(res, 201, { status: "created", record });
  }

  sendError(res, 404, "API route not found.");
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Internal server error.", [error.message]);
  }
});

server.listen(PORT, () => {
  console.log(`AG CRM running at http://127.0.0.1:${PORT}`);
  backupCrmData("startup");
  setInterval(() => backupCrmData("daily"), 24 * 60 * 60 * 1000).unref();
});
