// Log file management — rotation, cleanup, and stats.

import { execSync } from "child_process";
import { readdirSync, statSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

const TEN_MB = 10 * 1024 * 1024;

/**
 * Rotate log files larger than 10MB by compressing them with gzip.
 * Creates .gz archives with a timestamp suffix.
 */
export function rotateLogs(dir) {
  if (!existsSync(dir)) return [];

  const rotated = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".log"));

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const stat = statSync(filePath);
      if (stat.size > TEN_MB) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const archiveName = `${file}.${timestamp}.gz`;
        const archivePath = join(dir, archiveName);
        // gzip to archive, then truncate the original so the service keeps writing to it
        execSync(`gzip -c "${filePath}" > "${archivePath}" && : > "${filePath}"`, {
          encoding: "utf-8",
          timeout: 30000,
        });
        rotated.push({ file, archiveName, originalSize: stat.size });
      }
    } catch {
      // Skip files we can't stat or compress
    }
  }

  return rotated;
}

/**
 * Delete .gz archive files older than maxAgeDays.
 */
export function cleanOldLogs(dir, maxAgeDays = 7) {
  if (!existsSync(dir)) return [];

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const deleted = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".gz"));

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        unlinkSync(filePath);
        deleted.push({ file, age: Math.floor((Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000)) });
      }
    } catch {
      // Skip files we can't stat or delete
    }
  }

  return deleted;
}

/**
 * Get stats about the logs directory.
 */
export function getLogStats(dir) {
  if (!existsSync(dir)) {
    return { totalSize: 0, fileCount: 0, oldestFile: null, newestFile: null };
  }

  const files = readdirSync(dir);
  let totalSize = 0;
  let oldest = null;
  let newest = null;

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      totalSize += stat.size;

      if (!oldest || stat.mtimeMs < oldest.mtimeMs) {
        oldest = { file, mtimeMs: stat.mtimeMs };
      }
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { file, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Skip
    }
  }

  return {
    totalSize,
    fileCount: files.length,
    oldestFile: oldest ? oldest.file : null,
    newestFile: newest ? newest.file : null,
  };
}

/**
 * Format bytes into human-readable string.
 */
export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
