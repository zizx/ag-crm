# AI Agent Instructions

AG CRM is intended to be operated and improved by humans and coding agents.

## Logging Expectations

The AI agent developing this app should add and preserve useful logs so problems can be diagnosed from system state without the user having to explain every detail again.

Add logs where they help trace failures or bad data:

- Browser extension: capture attempts, reveal/rescan attempts, extracted fields, save status, and validation errors.
- CRM API: create/update requests, duplicate detection, validation failures, source metadata, and unexpected errors.
- CRM interface: failed saves, failed loads, empty states that should not be empty, and important user actions.
- Future automation: OCR attempts, email ingestion, scheduled jobs, retry decisions, and skipped duplicates.

Logs should include timestamp, actor type, source/platform when relevant, operation name, status, and concise error details. Do not log secrets, API keys, auth tokens, or unnecessary personal data.

## AI Extraction Debug Reports

Every AI extraction run, recipe save, recipe run failure, and client-side recipe rejection writes a full debug report to `data/ai-debug/` (last 40 kept, gitignored). Reports contain the exact LLM inputs (system prompt, truncated page text and DOM skeleton), the raw LLM output, parsed leads/recipe, token usage, and timing. Browse via `GET /api/extract/debug` (list) and `GET /api/extract/debug?file=<name>` (full report).

When iterating on the extraction prompt, recipe format, or recipe validation, read these reports FIRST — they show what the model actually received and returned, so you can fix the real failure instead of guessing. Keep this reporting working when you change the extraction pipeline, and never write secrets into reports.

## Product Direction

This CRM should evolve into a SaaS product. Supabase/Postgres is the intended future database foundation because it supports multi-tenant data, Auth, Storage, Row Level Security, and a clean path from local MVP to SaaS.

## Current Development Rules

- Keep the browser extension and AI agent using the CRM API, not direct data-file writes.
- Preserve actor/source metadata on automated writes.
- Keep lead source/platform separate from contact company.
- Keep the schema and API compatible with a future Supabase/Postgres migration.
- Prefer small verified iterations over broad rewrites.
