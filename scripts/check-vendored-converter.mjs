import path from "node:path";
import { fileURLToPath } from "node:url";
import { findVendorProblems, vendorDirName } from "./vendored-converter.mjs";

// `prepack` guard: publishing without the vendored converter would ship a
// package whose PDF generation cannot work, so refuse to pack in that case.
const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const problems = await findVendorProblems(packageRoot);
if (problems.length > 0) {
  console.error(`Refusing to pack: the vendored PDF converter is not usable.`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    `Run \`npm ci\` (its prepare step builds ${vendorDirName}) or \`node scripts/prepare-ksef-pdf-generator.mjs --force\`.`,
  );
  process.exitCode = 1;
}
