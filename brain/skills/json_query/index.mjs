import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const name = "json_query";
export const description = "Read a JSON file and extract values using dot-notation paths.";
export const parameters = {
  file: { type: "string", description: "Absolute path to the JSON file", required: true },
  path: { type: "string", description: "Dot-notation path to extract (e.g. 'data.items.0.name')" }
};

export async function execute(args) {
  if (!args?.file) return "Error: file parameter is required";

  const filePath = resolve(args.file);
  let data;
  try {
    const raw = readFileSync(filePath, "utf-8");
    data = JSON.parse(raw);
  } catch (e) {
    return `Error reading/parsing ${filePath}: ${e.message}`;
  }

  if (!args.path) {
    return JSON.stringify(data, null, 2).slice(0, 8000);
  }

  const segments = args.path.split(".");
  let current = data;
  for (const seg of segments) {
    if (current === null || current === undefined) {
      return `Path '${args.path}' — hit null/undefined at '${seg}'`;
    }
    if (Array.isArray(current) && /^\d+$/.test(seg)) {
      current = current[parseInt(seg, 10)];
    } else if (typeof current === "object") {
      current = current[seg];
    } else {
      return `Path '${args.path}' — '${seg}' is not traversable (value is ${typeof current})`;
    }
  }

  if (current === undefined) return `Path '${args.path}' — not found`;
  if (typeof current === "object") return JSON.stringify(current, null, 2).slice(0, 8000);
  return String(current);
}
