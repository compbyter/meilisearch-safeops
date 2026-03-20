import Fastify from "fastify";
import cors from "@fastify/cors";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const config = {
  port: Number(process.env.PORT || 3002),
  meiliHost: process.env.MEILI_HOST || "http://127.0.0.1:7700",
  meiliApiKey: process.env.MEILI_API_KEY || process.env.MEILI_MASTER_KEY || "",
  meiliImageTag: process.env.MEILI_IMAGE_TAG || "v1.38.2",
  targetMeiliVersion: process.env.TARGET_MEILI_VERSION || "",
  dumpDir: process.env.DUMP_DIR || "/meili_data/dumps",
  snapshotDir: process.env.SNAPSHOT_DIR || "/meili_data/snapshots",
  restoreStagingDir: process.env.RESTORE_STAGING_DIR || "/meili_data/restore-staging",
  backupPollMs: Number(process.env.BACKUP_POLL_MS || 2000),
  backupTimeoutMs: Number(process.env.BACKUP_TIMEOUT_MS || 300000),
  s3Enabled: String(process.env.S3_ENABLED || "false").toLowerCase() === "true",
  s3Bucket: process.env.S3_BUCKET || "",
  s3Region: process.env.S3_REGION || "",
  s3Prefix: process.env.S3_PREFIX || "meili-backups",
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ""
};

if (/latest/i.test(config.meiliImageTag)) {
  console.error("MEILI_IMAGE_TAG cannot be latest.");
  process.exit(1);
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const state = {
  lastDump: null,
  lastSnapshot: null,
  restoreJobs: new Map()
};

const s3Client = config.s3Enabled
  ? new S3Client({
      region: config.s3Region,
      credentials: {
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey
      }
    })
  : null;

function parseVersion(tag) {
  return String(tag || "")
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((item) => Number(item));
}

function checkUpgradeCompatibility(current, target) {
  if (!target) return { ok: true, reason: "target_not_set" };
  const [cMajor = 0, cMinor = 0] = parseVersion(current);
  const [tMajor = 0, tMinor = 0] = parseVersion(target);
  if (!cMajor || !tMajor) return { ok: true, reason: "version_parse_skipped" };
  if (tMajor !== cMajor) {
    return { ok: false, reason: "major_version_change" };
  }
  if (Math.abs(tMinor - cMinor) > 4) {
    return { ok: false, reason: "minor_jump_too_large" };
  }
  return { ok: true, reason: "compatible" };
}

async function meiliRequest(pathname, options = {}) {
  const response = await fetch(`${config.meiliHost}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.meiliApiKey}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Meili request failed (${response.status}): ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function listFiles(dir) {
  try {
    const files = await fs.readdir(dir);
    return files.map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function newestFile(dir, pattern = null) {
  const files = await listFiles(dir);
  const filtered = pattern ? files.filter((file) => pattern.test(path.basename(file))) : files;
  if (!filtered.length) return null;

  const withStats = await Promise.all(
    filtered.map(async (file) => ({
      file,
      stat: await fs.stat(file)
    }))
  );

  withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return withStats[0].file;
}

async function waitTask(taskUid) {
  const started = Date.now();

  while (Date.now() - started < config.backupTimeoutMs) {
    const task = await meiliRequest(`/tasks/${taskUid}`, { method: "GET" });
    if (task.status === "succeeded") return task;
    if (task.status === "failed" || task.status === "canceled") {
      throw new Error(`Task ${taskUid} ended with ${task.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.backupPollMs));
  }

  throw new Error(`Task timeout: ${taskUid}`);
}

async function uploadToS3(filePath, folder) {
  if (!config.s3Enabled || !s3Client) return null;
  const fileName = path.basename(filePath);
  const key = `${config.s3Prefix}/${folder}/${Date.now()}-${fileName}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: createReadStream(filePath)
    })
  );

  return key;
}

async function downloadFromS3(key) {
  if (!config.s3Enabled || !s3Client) {
    throw new Error("S3 is not enabled");
  }

  await ensureDir(config.restoreStagingDir);
  const targetPath = path.join(config.restoreStagingDir, path.basename(key));
  const object = await s3Client.send(
    new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: key
    })
  );

  await pipeline(object.Body, createWriteStream(targetPath));
  return targetPath;
}

app.get("/health", async () => {
  const health = await meiliRequest("/health", { method: "GET" });
  return { status: "ok", meili: health.status || "available" };
});

app.get("/ops/status", async () => {
  const version = await meiliRequest("/version", { method: "GET" });
  const compatibility = checkUpgradeCompatibility(version.pkgVersion, config.targetMeiliVersion);
  const dumpFile = await newestFile(config.dumpDir, /\.dump$/i);
  const snapshotFile = await newestFile(config.snapshotDir, /snapshot|\.snapshot$/i);

  return {
    meiliImageTag: config.meiliImageTag,
    targetMeiliVersion: config.targetMeiliVersion || null,
    currentVersion: version.pkgVersion,
    compatibility,
    s3Enabled: config.s3Enabled,
    lastDump: state.lastDump || dumpFile,
    lastSnapshot: state.lastSnapshot || snapshotFile,
    restoreJobs: state.restoreJobs.size
  };
});

app.post("/ops/backup/dump", async () => {
  await ensureDir(config.dumpDir);
  const task = await meiliRequest("/dumps", { method: "POST", body: JSON.stringify({}) });
  const taskUid = task.taskUid || task.uid;
  const done = await waitTask(taskUid);
  const dumpFile = await newestFile(config.dumpDir, /\.dump$/i);
  const s3Key = dumpFile ? await uploadToS3(dumpFile, "dumps") : null;

  state.lastDump = dumpFile;

  return {
    status: "ok",
    taskUid,
    taskStatus: done.status,
    dumpFile,
    s3Key
  };
});

app.post("/ops/backup/snapshot", async () => {
  await ensureDir(config.snapshotDir);
  const task = await meiliRequest("/snapshots", { method: "POST", body: JSON.stringify({}) });
  const taskUid = task.taskUid || task.uid;
  const done = await waitTask(taskUid);
  const snapshotFile = await newestFile(config.snapshotDir, /snapshot|\.snapshot$/i);
  const s3Key = snapshotFile ? await uploadToS3(snapshotFile, "snapshots") : null;

  state.lastSnapshot = snapshotFile;

  return {
    status: "ok",
    taskUid,
    taskStatus: done.status,
    snapshotFile,
    s3Key
  };
});

app.post("/ops/restore", async (request, reply) => {
  const body = request.body || {};
  const type = body.type === "snapshot" ? "snapshot" : "dump";

  let restoreFile = body.localPath || "";
  if (body.s3Key) {
    restoreFile = await downloadFromS3(body.s3Key);
  }

  if (!restoreFile) {
    return reply.code(400).send({ error: "localPath or s3Key is required" });
  }

  const exists = await fs
    .access(restoreFile)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return reply.code(404).send({ error: "restore file not found", restoreFile });
  }

  const restoreId = crypto.randomUUID();
  const envKey = type === "dump" ? "MEILI_IMPORT_DUMP" : "MEILI_IMPORT_SNAPSHOT";
  const manualSteps = [
    `1) Pause Meilisearch service`,
    `2) Set ${envKey}=${restoreFile} on Meilisearch service`,
    `3) Redeploy Meilisearch and wait until it becomes healthy`,
    `4) Remove ${envKey} variable`,
    `5) Redeploy once more in normal mode`
  ];

  const payload = {
    restoreId,
    type,
    restoreFile,
    createdAt: new Date().toISOString(),
    status: "manual_required",
    manualSteps
  };

  state.restoreJobs.set(restoreId, payload);

  return payload;
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send({ error: "internal_error", message: error.message });
});

app.listen({ port: config.port, host: "0.0.0.0" });
