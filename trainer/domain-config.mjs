// The Forge — Domain Configuration Loader
// Reads domain-specific config from domains/*.json
// All pipeline scripts use this to stay domain-agnostic.
//
// Usage:
//   import { loadDomain, getActiveDomain } from "./domain-config.mjs";
//   const domain = loadDomain("legal");  // or getActiveDomain() for current

import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAINS_DIR = resolve(__dirname, "domains");
const ACTIVE_FILE = resolve(__dirname, "domains", ".active");

const DEFAULT_DOMAIN = "coding";

/** Load a domain config by ID */
export function loadDomain(domainId) {
  const file = resolve(DOMAINS_DIR, `${domainId}.json`);
  if (!existsSync(file)) {
    throw new Error(`Domain "${domainId}" not found at ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Get the currently active domain ID */
export function getActiveDomainId() {
  if (existsSync(ACTIVE_FILE)) {
    return readFileSync(ACTIVE_FILE, "utf8").trim() || DEFAULT_DOMAIN;
  }
  return DEFAULT_DOMAIN;
}

/** Get the currently active domain config */
export function getActiveDomain() {
  return loadDomain(getActiveDomainId());
}

/** Set the active domain */
export function setActiveDomain(domainId) {
  // Validate it exists
  loadDomain(domainId);
  writeFileSync(ACTIVE_FILE, domainId + "\n");
}

/** List all available domains */
export function listDomains() {
  const files = readdirSync(DOMAINS_DIR).filter(
    (f) => f.endsWith(".json") && !f.startsWith(".")
  );
  return files.map((f) => {
    const domain = JSON.parse(readFileSync(resolve(DOMAINS_DIR, f), "utf8"));
    return {
      id: domain.id,
      name: domain.name,
      description: domain.description,
      model_prefix: domain.model_prefix,
      active: domain.id === getActiveDomainId(),
    };
  });
}

/** Get the Ollama URL for a domain — remote GPU if configured, else local */
export function getOllamaUrl(domain) {
  // Env override always wins
  if (process.env.OLLAMA_URL) return process.env.OLLAMA_URL;

  // Use remote GPU endpoint if domain has one configured
  if (domain?.remote?.ollama_url) return domain.remote.ollama_url;

  // Fallback to local
  return "http://localhost:11434";
}

export default { loadDomain, getActiveDomain, getActiveDomainId, setActiveDomain, listDomains, getOllamaUrl };
