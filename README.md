[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/meilisearch-safeops?referralCode=cXPwOK&utm_medium=integration&utm_source=template&utm_campaign=generic)

# Deploy and Host Meilisearch Safeops on Railway

Meilisearch Safeops is a production-focused template that adds operational safety around Meilisearch. It helps teams avoid version-related crashes, run repeatable backup/restore workflows, and keep deployments stable with pinned image versions and health checks.

## About Hosting Meilisearch Safeops

This template deploys Meilisearch with a companion SafeOps runner service on Railway. Meilisearch runs with a pinned image version (no `latest` drift), while SafeOps exposes operational endpoints for backup, snapshot, restore preparation, status checks, and file download operations. You can use local volume backups by default, and optionally enable S3 uploads for off-platform retention. The template is designed for teams that need reliability first: predictable upgrades, safer rollbacks, and less downtime during operational changes.

## Common Use Cases

- Protecting Meilisearch data before upgrades or infrastructure changes.
- Running repeatable dump/snapshot workflows with optional S3 retention.
- Preventing deployment instability caused by image/version mismatches.

## Dependencies for Meilisearch Safeops Hosting

- Meilisearch (pinned image tag, e.g. `getmeili/meilisearch:v1.38.2`)
- SafeOps runner service (Node.js API for backup/restore orchestration)

### Deployment Dependencies

- Meilisearch Docs: https://www.meilisearch.com/docs
- Meilisearch Update & Migration Guide: https://www.meilisearch.com/docs/learn/update_and_migration/updating
- Railway Docs: https://docs.railway.com
- AWS S3 (optional): https://docs.aws.amazon.com/s3/

### Implementation Details

SafeOps exposes:
- `GET /health`
- `GET /` (UI, Basic Auth protected)
- `GET /ops/status`
- `GET /ops/files?type=dump|snapshot`
- `GET /ops/files/:type/:name/download`
- `POST /ops/backup/dump`
- `POST /ops/backup/snapshot`
- `POST /ops/restore`

Recommended environment defaults:
- `MEILI_HTTP_ADDR=0.0.0.0:7700`
- `PORT=3002`
- `MEILI_DB_PATH=/meili_data/data.ms`
- `MEILI_IMAGE_TAG=v1.38.2`
- `SAFEOPS_ADMIN_USER=admin`
- `SAFEOPS_ADMIN_PASSWORD=${{ secret(24) }}`

## Why Deploy Meilisearch Safeops on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Meilisearch Safeops on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
