import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { logError, logInfo } from "./logger.js";

const PATH_KEYS = ["videoPath", "screenshotPath", "tracePath"];

const S3_PROVIDERS = new Set(["s3", "do_spaces"]);

function isStorageConfigured() {
  return (
    S3_PROVIDERS.has(config.artifactStorageProvider) &&
    config.storageBucket &&
    config.storageAccessKey &&
    config.storageSecretKey
  );
}

function createStorageClient() {
  // endpoint is optional: omit it for AWS S3 (the SDK derives it from region);
  // set it for S3-compatible stores (MinIO, DO Spaces, GCS interop).
  const clientConfig = {
    region: config.storageRegion || "us-east-1",
    forcePathStyle: config.storageForcePathStyle,
    credentials: {
      accessKeyId: config.storageAccessKey,
      secretAccessKey: config.storageSecretKey,
    },
  };
  if (config.storageEndpoint) clientConfig.endpoint = config.storageEndpoint;
  return new S3Client(clientConfig);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".zip") return "application/zip";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

function buildObjectKey(runId, jobId, filePath) {
  const safeName = path.basename(filePath).replace(/[^\w.-]/g, "_");
  return `tesbox-execution/${encodeURIComponent(String(runId))}/${encodeURIComponent(String(jobId))}/${safeName}`;
}

function buildPublicUrl(objectKey) {
  if (config.storagePublicBaseUrl) {
    return `${String(config.storagePublicBaseUrl).replace(/\/+$/, "")}/${objectKey}`;
  }
  if (config.storageEndpoint) {
    const endpointHost = String(config.storageEndpoint).replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${config.storageBucket}.${endpointHost}/${objectKey}`;
  }
  // AWS S3 virtual-hosted style.
  return `https://${config.storageBucket}.s3.${config.storageRegion || "us-east-1"}.amazonaws.com/${objectKey}`;
}

async function uploadFile(client, runId, jobId, filePath) {
  const body = await fs.readFile(filePath);
  const key = buildObjectKey(runId, jobId, filePath);
  const command = {
    Bucket: config.storageBucket,
    Key: key,
    Body: body,
    ContentType: contentTypeFor(filePath),
  };
  if (config.storageObjectAcl) command.ACL = config.storageObjectAcl;
  await client.send(new PutObjectCommand(command));
  return buildPublicUrl(key);
}

export async function uploadArtifactsIfConfigured(runId, jobId, result) {
  if (!result || !isStorageConfigured()) return result;

  const client = createStorageClient();
  const out = { ...result };

  for (const key of PATH_KEYS) {
    const localPath = result[key];
    if (!localPath) continue;
    try {
      out[key] = await uploadFile(client, runId, jobId, localPath);
    } catch (error) {
      logError("artifact_upload_failed", {
        runId,
        jobId,
        key,
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logInfo("artifact_upload_complete", {
    runId,
    jobId,
    uploaded: PATH_KEYS.filter((k) => out[k] && out[k] !== result[k]),
  });
  return out;
}
