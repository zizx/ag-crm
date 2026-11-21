# AG CRM

> **Status: early experiment (mid-2026), not maintained.** A side project exploring local-first lead capture with a browser extension and AI extraction. It runs on your own machine only; no data is included in this repository.

AG CRM is a small local CRM for collecting sales leads from web pages. A browser extension captures contact details from the page you are on and saves them to a local Node API. A web UI lets you review, edit and organise those leads, and export them to GoHighLevel.

## What works

- **CRM web UI.** People and Companies lists with search, sorting (recently updated / name / city) and a "needs review" filter. Each contact has notes, tasks, an activity timeline, attachments and inline editing. You can also bulk-archive and restore contacts.
- **Manual capture from the extension.** On sites you enable, a floating **Save to AG CRM** button opens a panel. The panel fills in name, company, title, email, phone, website and address from the page, and you review them before saving. **Reveal & Rescan** clicks "show number"-style controls and then reads the page again.
- **AI lead extraction on any page.** This works with OpenRouter or any OpenAI-compatible API. **✨ Get all leads (AI)** sends the visible page text and a reduced DOM outline to the LLM, which returns every lead on the page. You choose which ones to save from a review list.
- **Learned extraction recipes.** Along with the leads, the AI proposes CSS selectors (a "recipe"). The extension tests the recipe on the same page and keeps it only if it reproduces at least 70% of the AI's leads. After that, similar pages on that site are extracted locally with no AI call. A recipe that fails falls back to AI repair, and after 3 failures in a row it is disabled.
- **Duplicate handling.** Contacts are matched by email, phone, source URL or a profile ID in the URL. The extension warns you before saving a duplicate, and **Refresh** in the UI merges duplicates.
- **Review workflow.** Leads saved by automation are marked *pending review* until you confirm them.
- **GoHighLevel export.** Select people, then click **Export to GoHighLevel**. Contacts are pushed through the GHL v2 `/contacts/upsert` endpoint, and you get a created/updated/skipped/failed result for each one.
- **Structured queries.** `POST /api/contacts/query` takes filters such as `city = X AND website empty AND name starts with A`.
- **Local JSON storage.** Writes are atomic, and the server takes a backup on startup and once a day (the last 20 are kept). Each AI extraction also writes a debug report (`GET /api/extract/debug`).

## Quick start

Requirements: Node.js 22 or newer. There are no npm dependencies, so you don't need `npm install`.

```bash
npm run dev
```

Open <http://127.0.0.1:3210>.

### Load the browser extension

1. Open `chrome://extensions` in Chrome or Edge and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Keep the CRM server running. Then, on any site where you want capture, open the extension popup and click **Enable on this site**.

## Configuration

Secrets are read from `data/secrets.json`. You create this file yourself; it is gitignored and never sent to the browser:

```json
{
  "llm": {
    "provider": "openrouter",
    "base_url": "https://openrouter.ai/api/v1",
    "model": "<model-id>",
    "api_key": "<your-openrouter-key>"
  },
  "gohighlevel": {
    "private_integration_token": "<your-ghl-private-integration-token>",
    "default_location_id": "",
    "locations": []
  }
}
```

You can also use environment variables or a `.env` file in the project root (also gitignored). Variables that are already set take priority. Supported variables: `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `GHL_TOKEN`, `PORT`, `DATA_DIR`, `DATA_FILE` and `SECRETS_FILE`. The GoHighLevel token and location ID can also be entered in the export dialog.

Both keys are optional. Without an LLM key, manual capture and the CRM UI still work.

## Your data stays local

Everything is stored under `data/` on your machine: contacts (`crm.json`), backups, attachments, recipes, AI debug reports and secrets. That folder is gitignored and is not part of this repository. Data leaves your machine only in two cases: page content you choose to send to the LLM provider, and contacts you choose to export to GoHighLevel.

## Tests

```bash
npm run verify
```

This runs the API and extraction test suite with `node --test`. Each test starts the server against a temporary data directory. The LLM and GoHighLevel are mocked, so the tests need no network access and cost nothing.

## Layout

```text
src/server.js           Node HTTP API + static file server (no framework)
public/                 CRM web UI (index.html, app.js, styles.css)
extension/              Manifest V3 extension (popup, content scripts, AI extraction, recipes)
test/api.test.js        Test suite
CRM_AGENT_SAAS_SPEC.md  Original design notes
AGENTS.md               Conventions for coding agents working on the repo
```

## Not done

- No authentication or multiple users.
- No hosted database. The data layer sits behind one read/write function so it could be moved to Postgres/Supabase later.
- No OCR and no email ingestion.
