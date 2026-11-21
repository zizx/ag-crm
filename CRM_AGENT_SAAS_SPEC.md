# Agent-Ready CRM SaaS Spec

## Summary

Create a SaaS-ready CRM that can be used by both humans and an AI agent. The system starts as a lean MVP but keeps multi-tenant architecture and agent-safe APIs in the design from day one.

The long-term foundation is self-hosted Supabase: Postgres, Auth, Storage, Row Level Security, and Supabase Studio. The MVP in this repo starts with a local Node API and JSON storage so the human CRM and browser extension can be used immediately. The API and data shapes are intentionally aligned with the future Supabase/Postgres schema.

## Architecture

- Human users work through the CRM web app.
- The browser extension captures visible leads and saves them through the CRM API.
- The AI agent uses the same approved API surface as the app and extension.
- Business logic lives in the domain API, not in raw table writes.
- Supabase/Postgres should replace JSON storage when the product graduates from local MVP to SaaS foundation.

```text
CRM Web UI
Browser Extension
AI Agent Tools
        |
        v
Domain API
        |
        v
Local JSON now, Supabase/Postgres later
```

## Core Requirements

- Contacts can store name, title, company, emails, phones, tags, source URL, source domain, and capture date.
- Humans can search contacts and manage notes, tasks, and activity history.
- Duplicate contacts are detected by normalized email or phone.
- Every automated write records an actor type: `human`, `extension`, `ai_agent`, `scraper`, `import`, or `system`.
- The AI agent can create, search, and update CRM records through approved endpoints.
- The AI agent cannot delete records, change schema, or access unrestricted database credentials in v1.
- System logs and agent action logs must be readable for debugging.

## Implementation Status

Implemented now:

- Local Node CRM API with JSON persistence.
- CRM web UI for contact search, contact details, notes, tasks, activity timeline, and contact editing.
- Browser extension popup for scanning visible page data, reviewing fields, and saving leads.
- Extension extraction separates profile company from source platform/domain.
- Source records store URL, domain, platform, and capture time.
- Duplicate contact detection by normalized email or phone.
- Manual contact edits through `PATCH /api/contacts/:id`.
- Extension `Reveal & Rescan` flow for visible show-number controls, with repeated rescans and extension-side diagnostics.
- Extension duplicate warning via `/api/contacts/match` when revisiting a saved profile or matching email/phone.
- On-page floating capture button and panel on any site the user enables in the popup.
- Universal AI lead extraction (OpenRouter) with review-before-save and self-validating CSS extraction recipes.
- GoHighLevel export of selected contacts.
- `AGENTS.md` workflow documentation.
- Tests for contact upsert, edit, dedupe, child records, extension extraction, AI extraction, recipes, and GoHighLevel export.

Still needs implementation:

- Supabase/Postgres migration, Auth, Storage, and Row Level Security.
- Durable application logs visible inside the CRM interface, not only local JSON/system logs and extension storage.
- Better browser-extension diagnostics screen for last capture/reveal attempts.
- Site-specific reveal adapters for platforms that block scripted clicks, require login, open modals, or fetch phone numbers through private APIs.
- Imports, email/WhatsApp/Telegram ingestion, OCR, billing, and SaaS tenant administration.

## Required API

```http
GET  /api/health
GET  /api/contacts?q=
GET  /api/contacts/match?source_url=&emails=&phones=&name=
GET  /api/contacts/:id
GET  /api/search?q=
POST /api/contacts/upsert
PATCH /api/contacts/:id
POST /api/tasks
POST /api/notes
POST /api/activities
GET  /api/agent/logs
POST /api/agent/actions
GET  /api/ingestion-events
POST /api/ingestion-events
```

`POST /api/contacts/upsert` accepts:

```json
{
  "org_id": "org_default",
  "actor_type": "extension",
  "source": {
    "url": "https://example.com/profile",
    "domain": "example.com",
    "platform": "Example Platform",
    "captured_at": "2026-06-22T00:00:00.000Z"
  },
  "contact": {
    "name": "Ahmed Example",
    "title": "Founder",
    "company_name": "Example Co",
    "emails": ["ahmed@example.com"],
    "phones": ["+966 555 000 000"],
    "tags": ["example.com", "prospect"],
    "note": "Met via website."
  }
}
```

Response:

```json
{
  "status": "created",
  "contact_id": "uuid",
  "company_id": "uuid",
  "duplicate_contact_id": null,
  "activity_id": "uuid",
  "source_id": "uuid"
}
```

## SaaS Migration Requirements

When moving to Supabase/Postgres, every tenant-owned table must include:

```sql
id uuid primary key
org_id uuid not null
created_by_user_id uuid null
created_by_actor_type text not null
created_at timestamptz not null
updated_at timestamptz not null
deleted_at timestamptz null
```

Required tables:

- `organizations`
- `users` or Supabase `auth.users` profile mirror
- `memberships`
- `companies`
- `contacts`
- `contact_methods`
- `tags`
- `contact_tags`
- `activities`
- `notes`
- `tasks`
- `files`
- `sources`
- `agent_actions`
- `system_logs`
- `ingestion_events`

## Deferred Features

- Supabase Auth and RLS.
- File uploads through Supabase Storage.
- Telegram, WhatsApp, and email ingestion.
- OCR for screenshots and business cards.
- Billing and subscriptions.
- NocoDB or Directus admin integration.
- Agent-generated code changes.

## Acceptance Criteria

- A human can create and search leads in the CRM UI.
- A human can open a contact and add notes and tasks.
- The browser extension can scan the active tab and save a lead through the API.
- Duplicate emails or phones update the existing contact instead of creating a new one.
- API writes include actor type and source metadata.
- AI-agent-compatible endpoints exist for future tool use.
- Smoke tests pass.
