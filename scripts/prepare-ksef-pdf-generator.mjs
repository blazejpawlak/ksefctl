import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleFileName,
  converterPackageName,
  findVendorProblems,
  licenseFileName,
  metadataFileName,
  noticesFileName,
  readInstalledCommit,
  readPin,
  sha256,
  vendorDir,
} from "./vendored-converter.mjs";
import { buildNotices } from "./third-party-notices.mjs";

// Development-time step, run from the `prepare` lifecycle (local `npm install`
// and `npm ci`, and before pack/publish; npm does not run it when a consumer
// installs the registry tarball). It builds the commit-pinned converter
// devDependency and vendors the ESM bundle that ksefctl ships and loads, with
// the notices of the third-party code and assets the bundle embeds.
// Pass --force to rebuild a vendored copy that is already up to date.
const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const converterRoot = path.join(
  packageRoot,
  "node_modules",
  ...converterPackageName.split("/"),
);

// npm 11 gates dependency install scripts behind an allowlist. The converter is
// installed as its own project, so the root package.json allowScripts does not
// apply; its Vite build needs esbuild's postinstall (fsevents is macOS-only).
const converterAllowedScripts = ["esbuild", "fsevents"];

// The converter's own install and build print upstream warnings (its dev
// dependencies, Vite and declaration output) that ksefctl cannot act on. They
// go to a log file; it is printed only when a step fails.
const logFileName = "ksefctl-prepare.log";
const failureTailLines = 80;

// The converter must be installed as a local project with its dev dependencies,
// whatever mode the outer install runs in. During `npm install --global` npm
// exports npm_config_global=true (plus prefix and location) to lifecycle
// scripts, which would make the nested `npm install` put the converter into the
// global prefix instead, and production installs omit the devDependencies the
// build needs. The README's `--allow-scripts=...` is exported too, and npm 11
// rejects it in a project-scoped install (EALLOWSCRIPTS); dropping it also lets
// the converter's own .npmrc allowlist govern rather than a blanket
// --dangerously-allow-all-scripts. Registry, auth, proxy and cache settings are
// left inherited.
const inheritedInstallModeVariables = new Set([
  "npm_config_global",
  "npm_config_location",
  "npm_config_prefix",
  "npm_config_local_prefix",
  "npm_config_omit",
  "npm_config_only",
  "npm_config_production",
  "npm_config_dev",
  "npm_config_allow_scripts",
  "npm_config_dangerously_allow_all_scripts",
]);
const localInstallEnv = () => {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!inheritedInstallModeVariables.has(name.toLowerCase().replaceAll("-", "_"))) {
      env[name] = value;
    }
  }
  if (env.NODE_ENV === "production") {
    delete env.NODE_ENV;
  }
  return env;
};
const localInstallFlags = ["--global=false", "--location=project", "--include=dev"];

const runLogged = async (command, args, cwd, logPath) => {
  const result = spawnSync(command, args, {
    cwd,
    env: localInstallEnv(),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  await fs.appendFile(
    logPath,
    `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`,
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`,
    );
  }
};

// npm versions without allowScripts warn about an unknown "allow-scripts"
// config key, so only write it where npm understands it. Only an unknown
// command means "unsupported": any other probe failure is left for the install
// step to report rather than silently dropping the allowlist.
const supportsAllowScripts = (cwd) => {
  const probe = spawnSync(
    "npm",
    ["install-scripts", "ls", ...localInstallFlags],
    { cwd, env: localInstallEnv(), encoding: "utf-8" },
  );
  return !(
    probe.status !== 0 &&
    /unknown command/i.test(`${probe.stdout ?? ""}${probe.stderr ?? ""}`)
  );
};

const writeAllowScriptsConfig = async (packageRoot) => {
  const npmrcPath = path.join(packageRoot, ".npmrc");
  if (!supportsAllowScripts(packageRoot)) {
    await fs.rm(npmrcPath, { force: true });
    return;
  }
  await fs.writeFile(
    npmrcPath,
    converterAllowedScripts.map((name) => `allow-scripts[]=${name}\n`).join(""),
  );
};

// The upstream license (MIT) must ship with the vendored bundle. The copy is
// staged next to the final directory and renamed into place, so an interrupted
// run never leaves a half-written vendor directory that looks complete.
const vendorArtifacts = async (version, pin) => {
  const bundle = await fs.readFile(path.join(converterRoot, "dist", bundleFileName));
  // The hidden map lists every module the bundle contains; it is not shipped.
  const mapPath = path.join(converterRoot, "dist", `${bundleFileName}.map`);
  try {
    await fs.access(mapPath);
  } catch {
    throw new Error(`The converter build produced no source map at ${mapPath}`);
  }
  const notices = await buildNotices({
    converterRoot,
    converter: { name: converterPackageName, version, ...pin },
    bundle,
    mapPath,
  });
  const target = vendorDir(packageRoot);
  const staging = `${target}.staging-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  try {
    await fs.writeFile(path.join(staging, bundleFileName), bundle);
    await fs.copyFile(
      path.join(converterRoot, licenseFileName),
      path.join(staging, licenseFileName),
    );
    await fs.writeFile(path.join(staging, noticesFileName), notices.text);
    await fs.writeFile(
      path.join(staging, metadataFileName),
      `${JSON.stringify(
        {
          name: converterPackageName,
          version,
          source: pin.source,
          commit: pin.commit,
          bundleSha256: sha256(bundle),
          noticesSha256: sha256(notices.text),
          components: notices.components,
        },
        null,
        2,
      )}\n`,
    );
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
};

const printLogTail = async (logPath) => {
  try {
    const lines = (await fs.readFile(logPath, "utf-8")).trimEnd().split("\n");
    console.error(lines.slice(-failureTailLines).join("\n"));
  } catch {
    // The log is best-effort context; the error message is reported anyway.
  }
};

const run = async () => {
  const pin = await readPin(packageRoot);
  if (
    !process.argv.includes("--force") &&
    (await findVendorProblems(packageRoot)).length === 0
  ) {
    console.log(`Vendored ${converterPackageName} is up to date`);
    return;
  }
  try {
    await fs.access(path.join(converterRoot, "package.json"));
  } catch {
    throw new Error(
      `Cannot find ${converterPackageName} in ${path.join(packageRoot, "node_modules")}. It is a devDependency used to build the vendored PDF converter; install with dev dependencies (npm ci).`,
    );
  }
  // The build uses whatever converter is installed, so make sure that is the
  // pinned commit before the output is labelled with it.
  const installed = await readInstalledCommit(packageRoot);
  if (installed !== pin.commit) {
    throw new Error(
      `The installed ${converterPackageName} is ${installed ? `at ${installed}` : "of unknown origin"}, but package.json pins ${pin.commit}. Run npm ci to install the pinned converter, then retry.`,
    );
  }
  const logPath = path.join(converterRoot, logFileName);
  await fs.writeFile(logPath, "");
  try {
    await writeAllowScriptsConfig(converterRoot);
    await runLogged(
      "npm",
      [
        "install",
        "--package-lock=false",
        "--no-fund",
        "--no-audit",
        ...localInstallFlags,
      ],
      converterRoot,
      logPath,
    );
    await runLogged(
      "npm",
      // A hidden source map (no sourceMappingURL comment, identical bundle
      // bytes) is the inventory of the code the bundle contains.
      [
        "run",
        "build",
        "--global=false",
        "--location=project",
        "--",
        "--sourcemap",
        "hidden",
      ],
      converterRoot,
      logPath,
    );
    const { version } = JSON.parse(
      await fs.readFile(path.join(converterRoot, "package.json"), "utf-8"),
    );
    await vendorArtifacts(version, pin);
    console.log(
      `Vendored ${converterPackageName} ${version} (build log: ${logPath})`,
    );
  } catch (error) {
    await printLogTail(logPath);
    console.error(`Full log: ${logPath}`);
    throw error;
  }
};

run().catch((error) => {
  console.error("Failed to vendor the ksef-pdf-generator converter");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
