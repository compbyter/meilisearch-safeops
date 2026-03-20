# Quickstart (10 Minutes)

## 1) Create Railway services

- `meilisearch` from `services/meilisearch`
- `safeops-runner` from `services/safeops-runner`

Attach a volume to both services at `/meili_data`.

## 2) Required variables

- `MEILI_HOST`
- `MEILI_API_KEY`
- `SAFEOPS_ADMIN_USER`
- `SAFEOPS_ADMIN_PASSWORD`
- `MEILI_IMAGE_TAG` (must not be `latest`)

Recommended:

- `MEILI_IMAGE_TAG=v1.38.2`
- `DUMP_DIR=/meili_data/dumps`
- `SNAPSHOT_DIR=/meili_data/snapshots`

## 3) Optional S3 backup

Set `S3_ENABLED=true` and provide AWS settings from `ENV.example`.

## 4) Health checks

- `safeops-runner`: `/health`
- `meilisearch`: `/health`

## 5) Smoke tests

```bash
curl -u admin:$SAFEOPS_ADMIN_PASSWORD "$SAFEOPS_URL/ops/status"
curl -u admin:$SAFEOPS_ADMIN_PASSWORD "$SAFEOPS_URL/ops/files?type=dump"
curl -u admin:$SAFEOPS_ADMIN_PASSWORD -X POST "$SAFEOPS_URL/ops/backup/dump"
curl -u admin:$SAFEOPS_ADMIN_PASSWORD -X POST "$SAFEOPS_URL/ops/backup/snapshot"
```

## 6) Restore workflow

`POST /ops/restore` prepares restore job metadata and returns controlled restart/import instructions.
