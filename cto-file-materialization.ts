import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, lstatSync, unlinkSync, writeFileSync, linkSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

export type SlackFile = {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

export type MaterializedAttachment = {
  file_id: string | null;
  name: string;
  mimetype: string | null;
  size: number | null;
  path: string | null;
  sha256: string | null;
  status: "saved" | "unavailable" | "unsupported" | "too_many";
  reason?: string;
};

export type SlackFilesClient = {
  files?: {
    info?: (args: { file: string; signal?: AbortSignal }) => Promise<unknown>;
  };
};

export type MaterializeOptions = {
  client: SlackFilesClient;
  token: string;
  rootDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxFiles?: number;
};

const DEFAULT_ROOT = "/tmp/cto-slack-images";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 8;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (["unsafe-url", "redirect-limit", "oversize", "invalid-image-payload", "file-metadata-unavailable", "path-collision", "unsafe-image-root", "unsafe-image-directory", "missing-file-id", "attachment-timeout"].includes(message)) return message;
  if (/^http-[0-9]{3}$/.test(message)) return message;
  return "download-failed";
}

function safeName(value: string | undefined, index: number, mimetype: string | null): string {
  const original = basename((value || "").replaceAll("\\", "/"));
  const cleaned = original.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "");
  if (cleaned) return cleaned.slice(0, 160);
  const extension = mimetype === "image/png" ? "png" : mimetype === "image/jpeg" ? "jpg" : mimetype === "image/gif" ? "gif" : "webp";
  return `image-${index + 1}.${extension}`;
}

function safeFileId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function safeMime(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value) ? value : null;
}

function eventDirectory(rootDir: string, eventKey: string): string {
  const digest = createHash("sha256").update(eventKey, "utf8").digest("hex");
  const path = join(rootDir, digest);
  if (existsSync(rootDir)) {
    const rootStat = lstatSync(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700) throw new Error("unsafe-image-root");
  } else {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  }
  const rootMetadata = lstatSync(rootDir);
  if (rootMetadata.uid !== process.getuid?.() || (rootMetadata.mode & 0o777) !== 0o700) throw new Error("unsafe-image-root");
  if (existsSync(path)) {
    const eventStat = lstatSync(path);
    if (!eventStat.isDirectory() || eventStat.isSymbolicLink() || eventStat.uid !== process.getuid?.() || (eventStat.mode & 0o777) !== 0o700) throw new Error("unsafe-image-directory");
  } else {
    mkdirSync(path, { mode: 0o700 });
  }
  const eventMetadata = lstatSync(path);
  if (eventMetadata.uid !== process.getuid?.() || (eventMetadata.mode & 0o777) !== 0o700) throw new Error("unsafe-image-directory");
  return path;
}

function checkedUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("unsafe-url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("unsafe-url");
  }
  if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password || url.port) {
    throw new Error("unsafe-url");
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new Error("invalid-image-payload");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error("attachment-timeout");
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel("oversize");
        throw new Error("oversize");
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchSlackBytes(url: URL, options: MaterializeOptions, signal: AbortSignal): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl || fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let current = url;
  for (let redirect = 0; redirect <= 1; redirect += 1) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: { Authorization: `Bearer ${options.token}` },
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirect === 1) throw new Error("redirect-limit");
      current = checkedUrl(response.headers.get("location"));
      continue;
    }
    if (!response.ok) throw new Error(`http-${response.status}`);
    const length = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(length) && length > maxBytes) throw new Error("oversize");
    return readBoundedBody(response, maxBytes, signal);
  }
  throw new Error("redirect-limit");
}

function validImagePayload(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).startsWith("GIF8")) return true;
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
}

function verifyPublished(path: string, expectedDigest: string, expectedSize: number): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600 || metadata.size !== expectedSize) throw new Error("path-collision");
  const actualDigest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actualDigest !== expectedDigest) throw new Error("path-collision");
}

function publishAtomically(path: string, bytes: Uint8Array, expectedDigest: string): void {
  const temporary = `${path}.part-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { encoding: "binary", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
  try {
    linkSync(temporary, path);
    unlinkSync(temporary);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    verifyPublished(path, expectedDigest, bytes.byteLength);
  }
  verifyPublished(path, expectedDigest, bytes.byteLength);
}

async function resolveFile(file: SlackFile, client: SlackFilesClient, signal: AbortSignal): Promise<SlackFile> {
  if (!file.id || !client.files?.info) throw new Error("file-metadata-unavailable");
  const result = await client.files.info({ file: file.id, signal });
  const remote = result && typeof result === "object" && "file" in result ? (result as { file?: unknown }).file : null;
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true || !remote || typeof remote !== "object") {
    throw new Error("file-metadata-unavailable");
  }
  return { ...file, ...(remote as SlackFile) };
}

async function runBoundedAttachmentOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("attachment-timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

export async function materializeSlackImages(
  files: SlackFile[],
  eventKey: string,
  options: MaterializeOptions,
): Promise<MaterializedAttachment[]> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const results: MaterializedAttachment[] = [];
  const imageFiles = files.filter((file) => typeof file === "object");
  let directory: string;
  try {
    directory = eventDirectory(options.rootDir ?? DEFAULT_ROOT, eventKey);
  } catch (error) {
    const reason = safeReason(error);
    return imageFiles.map((file, index) => ({
      file_id: safeFileId(file.id),
      name: safeName(file.name, index, typeof file.mimetype === "string" ? file.mimetype : null),
      mimetype: safeMime(file.mimetype),
      size: file.size ?? null,
      path: null,
      sha256: null,
      status: "unavailable" as const,
      reason,
    }));
  }
  for (let index = 0; index < imageFiles.length; index += 1) {
    const original = imageFiles[index];
    const fileId = safeFileId(original.id);
    const originalMime = safeMime(original.mimetype);
    const name = safeName(original.name, index, originalMime);
    if (index >= maxFiles) {
      results.push({ file_id: fileId, name, mimetype: originalMime, size: original.size ?? null, path: null, sha256: null, status: "too_many", reason: "attachment-limit" });
      continue;
    }
    if (!fileId) {
      results.push({ file_id: null, name, mimetype: originalMime, size: original.size ?? null, path: null, sha256: null, status: "unavailable", reason: "missing-file-id" });
      continue;
    }
    try {
      const resolved = await runBoundedAttachmentOperation(
        async (signal) => {
          const file = await resolveFile(original, options.client, signal);
          const mimetype = safeMime(file.mimetype);
          if (!mimetype || !ALLOWED_MIME.has(mimetype)) return { file, bytes: null as Uint8Array | null };
          const bytes = await fetchSlackBytes(checkedUrl(file.url_private_download || file.url_private), options, signal);
          return { file, bytes };
        },
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const file = resolved.file;
      const mimetype = safeMime(file.mimetype);
      if (!mimetype || !ALLOWED_MIME.has(mimetype)) {
        results.push({ file_id: fileId, name: safeName(file.name, index, mimetype), mimetype, size: file.size ?? null, path: null, sha256: null, status: "unsupported", reason: "unsupported-image-type" });
        continue;
      }
      const bytes = resolved.bytes;
      if (!bytes) throw new Error("invalid-image-payload");
      if (!validImagePayload(bytes)) throw new Error("invalid-image-payload");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const finalPath = join(directory, `${String(index + 1).padStart(2, "0")}-${safeName(file.name, index, mimetype)}`);
      publishAtomically(finalPath, bytes, digest);
      results.push({ file_id: fileId, name: safeName(file.name, index, mimetype), mimetype, size: bytes.byteLength, path: finalPath, sha256: digest, status: "saved" });
    } catch (error) {
      results.push({ file_id: fileId, name, mimetype: originalMime, size: original.size ?? null, path: null, sha256: null, status: "unavailable", reason: safeReason(error) });
    }
  }
  return results;
}
