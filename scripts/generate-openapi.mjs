import fs from "node:fs/promises";
import path from "node:path";
import openapiTS, { astToString } from "openapi-typescript";

const specUrl = "https://raw.githubusercontent.com/CIRFMF/ksef-docs/main/open-api.json";
const vendorDir = path.resolve("vendor");
const specPath = path.join(vendorDir, "open-api.json");
const outPath = path.resolve("src/api/types.ts");

const response = await fetch(specUrl);
if (!response.ok) {
  throw new Error(`Failed to fetch OpenAPI: ${response.status} ${response.statusText}`);
}

const schema = await response.json();
await fs.mkdir(vendorDir, { recursive: true });
await fs.writeFile(specPath, JSON.stringify(schema, null, 2));

const output = await openapiTS(schema, { exportType: true });
const content = typeof output === "string" ? output : astToString(output);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, content);

console.log(`OpenAPI types written to ${outPath}`);
