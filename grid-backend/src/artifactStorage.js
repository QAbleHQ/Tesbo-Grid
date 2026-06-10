import path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "./logger.js";

function readEnv(name, fallback = "") {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

// Artifact storage config. Generic S3-compatible: AWS S3, GCS (interop), MinIO,
// DO Spaces, etc. SPACES_* names are honored as back-compat aliases for S3_*.
const STORAGE_CONFIG = {
  provider: readEnv("ARTIFACT_STORAGE_PROVIDER", "none"),
  endpoint: readEnv("S3_ENDPOINT", readEnv("SPACES_ENDPOINT", "")),
  region: readEnv("S3_REGION", readEnv("SPACES_REGION", "us-east-1")),
  bucket: readEnv("S3_BUCKET", readEnv("SPACES_BUCKET", "")),
  accessKey: readEnv("S3_ACCESS_KEY", readEnv("SPACES_ACCESS_KEY", "")),
  secretKey: readEnv("S3_SECRET_KEY", readEnv("SPACES_SECRET_KEY", "")),
  publicBaseUrl: readEnv("S3_PUBLIC_BASE_URL", readEnv("SPACES_PUBLIC_BASE_URL", "")),
  forcePathStyle: readEnv("S3_FORCE_PATH_STYLE", "false") === "true",
  objectAcl: readEnv("S3_OBJECT_ACL", "public-read"),
};

const S3_PROVIDERS = new Set(["s3", "do_spaces"]);

export function isArtifactStorageConfigured() {
  return (
    S3_PROVIDERS.has(STORAGE_CONFIG.provider) &&
    STORAGE_CONFIG.bucket &&
    STORAGE_CONFIG.accessKey &&
    STORAGE_CONFIG.secretKey
  );
}

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  const clientConfig = {
    region: STORAGE_CONFIG.region || "us-east-1",
    forcePathStyle: STORAGE_CONFIG.forcePathStyle,
    credentials: {
      accessKeyId: STORAGE_CONFIG.accessKey,
      secretAccessKey: STORAGE_CONFIG.secretKey,
    },
  };
  // Omit endpoint for AWS S3 (derived from region); set it for S3-compatibles.
  if (STORAGE_CONFIG.endpoint) clientConfig.endpoint = STORAGE_CONFIG.endpoint;
  cachedClient = new S3Client(clientConfig);
  return cachedClient;
}

function contentTypeFor(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".zip") return "application/zip";
  if (ext === ".xml") return "application/xml";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

function buildPublicUrl(key) {
  if (STORAGE_CONFIG.publicBaseUrl) {
    return `${String(STORAGE_CONFIG.publicBaseUrl).replace(/\/+$/, "")}/${key}`;
  }
  if (STORAGE_CONFIG.endpoint) {
    const host = String(STORAGE_CONFIG.endpoint)
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
    return `https://${STORAGE_CONFIG.bucket}.${host}/${key}`;
  }
  // AWS S3 virtual-hosted style.
  return `https://${STORAGE_CONFIG.bucket}.s3.${STORAGE_CONFIG.region || "us-east-1"}.amazonaws.com/${key}`;
}

/**
 * Build the public URL for a Selenium session video. The selenium-node's
 * `video-uploader` sidecar uploads finalised recordings to
 *   <bucket>/selenium-sessions/<seleniumId>.mp4
 * once the session has ended. The dashboard calls this from the live
 * session detail page after the test wraps so users can replay what
 * happened — useful for failure triage now that VNC isn't available
 * post-mortem.
 *
 * Returns null when artifact storage isn't configured (self-hosted dev,
 * tests, etc.) so the dashboard can fall back gracefully.
 */
export function buildSeleniumSessionVideoUrl(seleniumId) {
  if (!seleniumId) return null;
  if (!isArtifactStorageConfigured()) return null;
  const safeId = String(seleniumId).replace(/[^A-Za-z0-9_.-]/g, "_");
  return buildPublicUrl(`selenium-sessions/${safeId}.mp4`);
}

/**
 * Upload an in-memory buffer to Spaces under
 *   tesbo-reports/<projectId>/<runId>/<safeName>
 * and return a public URL (or null when storage is not configured).
 */
export async function uploadReportArtifact({ projectId, runId, filename, buffer }) {
  if (!isArtifactStorageConfigured()) return null;
  const safeName = path.basename(String(filename || "file")).replace(/[^\w.-]/g, "_");
  const key = `tesbo-reports/${encodeURIComponent(String(projectId))}/${encodeURIComponent(
    String(runId)
  )}/${Date.now()}-${safeName}`;
  try {
    const command = {
      Bucket: STORAGE_CONFIG.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentTypeFor(safeName),
    };
    if (STORAGE_CONFIG.objectAcl) command.ACL = STORAGE_CONFIG.objectAcl;
    await getClient().send(new PutObjectCommand(command));
    return buildPublicUrl(key);
  } catch (err) {
    logger.error("Artifact storage upload failed:", { key, error: err?.message });
    return null;
  }
}
