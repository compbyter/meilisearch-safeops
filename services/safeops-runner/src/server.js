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
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  adminUser: process.env.SAFEOPS_ADMIN_USER || "admin",
  adminPassword: process.env.SAFEOPS_ADMIN_PASSWORD || ""
};

if (/latest/i.test(config.meiliImageTag)) {
  console.error("MEILI_IMAGE_TAG cannot be latest.");
  process.exit(1);
}

if (!config.adminPassword) {
  console.error("SAFEOPS_ADMIN_PASSWORD is required.");
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

function decodeBasicAuth(headerValue) {
  if (!headerValue || !headerValue.startsWith("Basic ")) return null;
  const encoded = headerValue.slice(6).trim();
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx === -1) return null;
  return {
    username: decoded.slice(0, idx),
    password: decoded.slice(idx + 1)
  };
}

function unauthorized(reply) {
  return reply
    .code(401)
    .header("WWW-Authenticate", 'Basic realm="Safeops Admin"')
    .send({ error: "unauthorized", message: "Invalid admin credentials." });
}

app.addHook("onRequest", async (request, reply) => {
  if (request.raw.url?.startsWith("/health")) return;
  if (request.method === "OPTIONS") return;

  const auth = decodeBasicAuth(request.headers.authorization);
  if (!auth) return unauthorized(reply);

  if (auth.username !== config.adminUser || auth.password !== config.adminPassword) {
    return unauthorized(reply);
  }
});

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

function getFileCollection(type) {
  if (type === "dump") {
    return { type: "dump", dir: config.dumpDir, pattern: /\.dump$/i };
  }
  if (type === "snapshot") {
    return { type: "snapshot", dir: config.snapshotDir, pattern: /snapshot|\.snapshot$/i };
  }
  return null;
}

async function listFilesDetailed(dir, pattern = null) {
  try {
    const names = await fs.readdir(dir);
    const rows = [];
    for (const name of names) {
      const filePath = path.join(dir, name);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      if (pattern && !pattern.test(name)) continue;
      rows.push({
        name,
        path: filePath,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
    rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return rows;
  } catch {
    return [];
  }
}

async function newestFile(dir, pattern = null) {
  const rows = await listFilesDetailed(dir, pattern);
  return rows.length ? rows[0].path : null;
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

function extractTaskUid(payload) {
  if (!payload) return null;
  if (typeof payload === "number") return payload;
  if (typeof payload === "string" && /^\d+$/.test(payload)) return Number(payload);
  if (payload.taskUid != null) return Number(payload.taskUid);
  if (payload.uid != null) return Number(payload.uid);
  if (payload.task && payload.task.taskUid != null) return Number(payload.task.taskUid);
  if (payload.task && payload.task.uid != null) return Number(payload.task.uid);
  if (payload.updateId != null) return Number(payload.updateId);
  return null;
}

async function findLatestTaskUid(taskType) {
  const data = await meiliRequest(
    `/tasks?types=${encodeURIComponent(taskType)}&statuses=enqueued,processing,succeeded&limit=1`,
    { method: "GET" }
  );
  const results = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : [];
  if (!results.length) return null;
  return extractTaskUid(results[0]);
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

app.get("/", async (_request, reply) => {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meili Safeops</title>
  <style>
    :root {
      --bg: #0b1020;
      --card: #121a31;
      --soft: #1a2547;
      --text: #eaf0ff;
      --muted: #9fb0dc;
      --ok: #26d07c;
      --warn: #ffca55;
      --err: #ff6b6b;
      --accent: #5aa9ff;
      --line: #2a3868;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      background: radial-gradient(circle at top right, #1d2d5a, var(--bg) 40%);
      color: var(--text);
    }
    .wrap {
      max-width: 980px;
      margin: 28px auto;
      padding: 0 16px;
      display: grid;
      gap: 16px;
    }
    .card {
      background: rgba(18, 26, 49, 0.95);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
    }
    h1, h2, h3 { margin: 0 0 10px; }
    h1 { font-size: 24px; }
    h2 { font-size: 16px; color: var(--muted); }
    h3 { font-size: 14px; color: var(--muted); }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    .kpi {
      flex: 1;
      min-width: 180px;
      background: var(--soft);
      border-radius: 10px;
      padding: 10px;
    }
    .kpi .label { color: var(--muted); font-size: 12px; }
    .kpi .value { font-weight: 700; margin-top: 3px; word-break: break-all; }
    button, a.dl {
      border: 0;
      border-radius: 9px;
      padding: 10px 14px;
      color: #051025;
      background: var(--accent);
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    input, select {
      width: 100%;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid #314378;
      background: #0d1430;
      color: var(--text);
      margin-bottom: 10px;
    }
    pre {
      margin: 0;
      background: #0a1128;
      border: 1px solid #2b3e72;
      border-radius: 10px;
      padding: 12px;
      max-height: 360px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.5;
    }
    .badge { font-weight: 700; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .err { color: var(--err); }
    .muted { color: var(--muted); font-size: 12px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      text-align: left;
      padding: 8px 6px;
      vertical-align: top;
      word-break: break-all;
    }
    th { color: var(--muted); font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Meili Safeops Runner</h1>
      <h2>Backup, snapshot and restore operations panel</h2>
      <div class="row">
        <div class="kpi"><div class="label">Meili Host</div><div class="value" id="meiliHost">-</div></div>
        <div class="kpi"><div class="label">Current Version</div><div class="value" id="currentVersion">-</div></div>
        <div class="kpi"><div class="label">Compatibility</div><div class="value" id="compatibility">-</div></div>
      </div>
      <div class="row" style="margin-top:10px;">
        <button id="refreshBtn">Refresh Status</button>
        <button id="dumpBtn">Create Dump Backup</button>
        <button id="snapshotBtn">Create Snapshot Backup</button>
      </div>
      <div class="muted" style="margin-top:8px;">Auth user: ${config.adminUser}. API calls require Basic Auth.</div>
    </div>

    <div class="card">
      <h1 style="font-size:18px;">Backups</h1>
      <div class="row">
        <div style="flex:1; min-width:320px;">
          <h3>Dumps</h3>
          <table>
            <thead><tr><th>File</th><th>Updated</th><th>Size</th><th>Action</th></tr></thead>
            <tbody id="dumpRows"><tr><td colspan="4">Loading...</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="row" style="margin-top:12px;">
        <div style="flex:1; min-width:320px;">
          <h3>Snapshots</h3>
          <table>
            <thead><tr><th>File</th><th>Updated</th><th>Size</th><th>Action</th></tr></thead>
            <tbody id="snapshotRows"><tr><td colspan="4">Loading...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <h1 style="font-size:18px;">Restore Request</h1>
      <div class="row">
        <div style="flex:1; min-width:220px;">
          <label>Type</label>
          <select id="restoreType">
            <option value="dump">dump</option>
            <option value="snapshot">snapshot</option>
          </select>
        </div>
        <div style="flex:2; min-width:300px;">
          <label>Local Path (optional)</label>
          <input id="restorePath" placeholder="/meili_data/dumps/my.dump" />
        </div>
      </div>
      <div class="row">
        <div style="flex:1; min-width:300px;">
          <label>S3 Key (optional)</label>
          <input id="s3Key" placeholder="meili-backups/dumps/..." />
        </div>
      </div>
      <button id="restoreBtn">Create Restore Job</button>
    </div>

    <div class="card">
      <h1 style="font-size:18px;">Response</h1>
      <pre id="output">Ready.</pre>
    </div>
  </div>

  <script>
    const output = document.getElementById("output");
    const meiliHost = document.getElementById("meiliHost");
    const currentVersion = document.getElementById("currentVersion");
    const compatibility = document.getElementById("compatibility");
    const dumpRows = document.getElementById("dumpRows");
    const snapshotRows = document.getElementById("snapshotRows");

    function setOutput(data) {
      output.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }

    function formatSize(bytes) {
      const n = Number(bytes || 0);
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
      return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    }

    async function api(path, options = {}) {
      const res = await fetch(path, options);
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!res.ok) throw data;
      return data;
    }

    function renderFiles(target, type, files) {
      if (!files.length) {
        target.innerHTML = '<tr><td colspan="4">No files found.</td></tr>';
        return;
      }
      target.innerHTML = files.map((file) => {
        const href = "/ops/files/" + type + "/" + encodeURIComponent(file.name) + "/download";
        return "<tr>" +
          "<td>" + file.name + "</td>" +
          "<td>" + (file.updatedAt || "-") + "</td>" +
          "<td>" + formatSize(file.sizeBytes) + "</td>" +
          "<td><a class='dl' href='" + href + "'>Download</a></td>" +
          "</tr>";
      }).join("");
    }

    async function refreshFiles() {
      const dumps = await api("/ops/files?type=dump");
      const snapshots = await api("/ops/files?type=snapshot");
      renderFiles(dumpRows, "dump", dumps.files || []);
      renderFiles(snapshotRows, "snapshot", snapshots.files || []);
    }

    async function refreshStatus() {
      try {
        const data = await api("/ops/status");
        meiliHost.textContent = "${config.meiliHost}";
        currentVersion.textContent = data.currentVersion || "-";
        const c = data.compatibility || {};
        const cls = c.ok ? "ok" : "warn";
        compatibility.innerHTML = '<span class="badge ' + cls + '">' + (c.ok ? "compatible" : "check_required") + "</span> (" + (c.reason || "-") + ")";
        setOutput(data);
      } catch (e) {
        compatibility.innerHTML = '<span class="badge err">error</span>';
        setOutput(e);
      }
    }

    async function runAction(button, fn) {
      button.disabled = true;
      try { await fn(); } finally { button.disabled = false; }
    }

    document.getElementById("refreshBtn").addEventListener("click", () =>
      runAction(document.getElementById("refreshBtn"), async () => {
        await refreshStatus();
        await refreshFiles();
      })
    );

    document.getElementById("dumpBtn").addEventListener("click", () =>
      runAction(document.getElementById("dumpBtn"), async () => {
        const data = await api("/ops/backup/dump", { method: "POST" });
        setOutput(data);
        await refreshStatus();
        await refreshFiles();
      })
    );

    document.getElementById("snapshotBtn").addEventListener("click", () =>
      runAction(document.getElementById("snapshotBtn"), async () => {
        const data = await api("/ops/backup/snapshot", { method: "POST" });
        setOutput(data);
        await refreshStatus();
        await refreshFiles();
      })
    );

    document.getElementById("restoreBtn").addEventListener("click", () =>
      runAction(document.getElementById("restoreBtn"), async () => {
        const payload = {
          type: document.getElementById("restoreType").value,
          localPath: document.getElementById("restorePath").value.trim(),
          s3Key: document.getElementById("s3Key").value.trim()
        };
        if (!payload.localPath) delete payload.localPath;
        if (!payload.s3Key) delete payload.s3Key;
        const data = await api("/ops/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        setOutput(data);
      })
    );

    (async () => {
      await refreshStatus();
      await refreshFiles();
    })();
  </script>
</body>
</html>`;

  reply.type("text/html; charset=utf-8").send(html);
});

app.get("/ops/files", async (request, reply) => {
  const type = String(request.query?.type || "dump").toLowerCase();
  const collection = getFileCollection(type);
  if (!collection) {
    return reply.code(400).send({ error: "invalid_type", message: "type must be dump or snapshot" });
  }

  const files = await listFilesDetailed(collection.dir, collection.pattern);
  return { status: "ok", type: collection.type, files };
});

app.get("/ops/files/:type/:name/download", async (request, reply) => {
  const type = String(request.params?.type || "").toLowerCase();
  const collection = getFileCollection(type);
  if (!collection) {
    return reply.code(400).send({ error: "invalid_type", message: "type must be dump or snapshot" });
  }

  const requestedName = decodeURIComponent(String(request.params?.name || ""));
  if (!requestedName || path.basename(requestedName) !== requestedName) {
    return reply.code(400).send({ error: "invalid_file_name" });
  }

  if (collection.pattern && !collection.pattern.test(requestedName)) {
    return reply.code(400).send({ error: "invalid_file_type" });
  }

  const filePath = path.join(collection.dir, requestedName);
  const exists = await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return reply.code(404).send({ error: "file_not_found", file: requestedName });
  }

  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Disposition", `attachment; filename="${requestedName}"`);
  return reply.send(createReadStream(filePath));
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
  let taskUid = extractTaskUid(task);
  if (!taskUid) {
    taskUid = await findLatestTaskUid("dumpCreation");
  }
  if (!taskUid) {
    throw new Error("Could not determine dump task UID from Meilisearch response.");
  }
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
  let taskUid = extractTaskUid(task);
  if (!taskUid) {
    taskUid = await findLatestTaskUid("snapshotCreation");
  }
  if (!taskUid) {
    throw new Error("Could not determine snapshot task UID from Meilisearch response.");
  }
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
