# Meili SafeOps

Operational template for Meilisearch stability, backup workflow, and upgrade guardrails.

## Services

- `meilisearch`: pinned image (`getmeili/meilisearch:v1.38.2`)
- `safeops-runner`: backup and restore orchestration API

## Public API (`safeops-runner`)

- `GET /health`
- `GET /` (web UI)
- `GET /ops/status`
- `GET /ops/files?type=dump|snapshot`
- `GET /ops/files/:type/:name/download`
- `POST /ops/backup/dump`
- `POST /ops/backup/snapshot`
- `POST /ops/restore`

## What it solves

- Prevents `latest` image drift.
- Adds backup task orchestration.
- Lists and downloads backup files from UI/API.
- Supports optional S3 upload.
- Adds pre-upgrade compatibility checks.
- Protects UI and API with Basic Auth (`SAFEOPS_ADMIN_USER` / `SAFEOPS_ADMIN_PASSWORD`).

## Limits

- Online in-place restore is not supported.
- Restore endpoint prepares a restore job and instructions for controlled restart/import.
