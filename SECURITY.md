# Security Policy

RVP ERP handles accounting records, party master data and bank details for RVP Industries.
This document says how to report a problem and what we do about it.

## Reporting a vulnerability

Report privately — please do **not** open a public GitHub issue, and do not post details in a
Slack channel or WhatsApp group.

- Email: **security@rvpindustries.example** with `SECURITY` in the subject line.
  <!-- TODO: replace with the real security contact before sharing this repo or
       handing it to the VAPT auditor. -->

- Include: what you found, the steps to reproduce it, the affected URL or file, and what an
  attacker could do with it. A screenshot or a short request/response capture helps.
- Please do not test against production (`rvp-industries.vercel.app` /
  `rvp-server.onrender.com`) beyond what is needed to demonstrate the issue, and never with
  another user's account. No load testing, no data deletion, no changes to live records.

We aim to acknowledge a report within **3 working days** and to have a fix or a mitigation plan
within **30 days** for anything rated high or critical.

## Scope

In scope: the ERP server (`server/`), the web client (`client/`), the cabin agents
(`scripts/cctv-bridge.mjs`, `scripts/cabin-print-agent.mjs`, `scripts/cabin-supervisor.mjs`),
and the deployment configuration in this repository.

Out of scope: findings that only affect a third-party service we consume (Supabase, Render,
Vercel, Resend, Fast2SMS, Slack, Google Gemini, TaxPro, Razorpay) — report those to the vendor;
missing hardening on endpoints that are intentionally public (`/api/health`); and reports
produced solely by an automated scanner with no demonstrated impact.

## Handling personal data

Party and driver records contain names, phone numbers, addresses, GSTINs and bank account
details. Treat all of it as personal data under the **DPDP Act 2023**:

- Never copy production data into a local file, a spreadsheet, a ticket, or an AI prompt.
- Never commit a database dump. `server/backups/` and `*.xlsx` are gitignored for this reason.
- Incidents involving personal data may carry **CERT-In** reporting obligations (6 hours for
  certain categories). Escalate to the owner immediately rather than waiting for a fix.

## Secrets

All credentials come from environment variables — see `server/.env.example` for the full list.

- No secret belongs in code, in a test fixture, in a log line, or in this repository.
- `.env` and `.env.*` are gitignored (`.env.example` excepted).
- CI runs `gitleaks` on every push and pull request.
- Install the local pre-commit scan once per clone:

  ```bash
  git config core.hooksPath .githooks
  ```

- If a secret is ever committed: rotate it first (Render, Supabase, Vercel or the vendor's own
  dashboard), then clean the history. Rotation comes first — the commit is already public.

## Supported versions

This is a single-tenant deployment with one production instance. Only `main` is supported;
fixes are rolled forward, never backported.

## Current security work

Hardening is tracked in [`SECURITY_PLAN.md`](SECURITY_PLAN.md), with the audit and per-phase
notes in [`docs/security/`](docs/security/). An annual VAPT by a CERT-In empanelled auditor is
planned.
