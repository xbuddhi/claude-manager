// Release build settings that depend on which secrets and variables the repository has, used by
// .github/workflows/release.yml. Each part turns on only when everything it needs is there, so a fork
// without secrets still gets a complete (unsigned) draft release, and the notes say what is missing.
//
//   node scripts/release-config.mjs build <out.json>   (in a build job) writes a `tauri build --config` file,
//       sets step outputs `config` and `trusted_signing`, and passes the signing secrets that apply on to
//       later steps (GITHUB_ENV), never printing them
//   node scripts/release-config.mjs notes <tag>        prints the release notes
//
// Inputs (environment): UPDATER_PUBKEY (variable), TAURI_SIGNING_PRIVATE_KEY(_PASSWORD), APPLE_CERTIFICATE,
// APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID, AZURE_CLIENT_ID,
// AZURE_CLIENT_SECRET, AZURE_TENANT_ID (secrets), AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,
// AZURE_SIGNING_PROFILE (variables), GITHUB_REPOSITORY, RUNNER_OS.

import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const has = (env, ...names) => names.every((n) => typeof env[n] === "string" && env[n].trim() !== "");

const UPDATER = ["UPDATER_PUBKEY", "TAURI_SIGNING_PRIVATE_KEY"];
const APPLE_SIGN = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY"];
const APPLE_NOTARIZE = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
const AZURE = [
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_SIGNING_ENDPOINT",
  "AZURE_SIGNING_ACCOUNT",
  "AZURE_SIGNING_PROFILE",
];

/** What this release can do with the secrets it has. */
export function status(env) {
  const macSigned = has(env, ...APPLE_SIGN);
  return {
    updater: has(env, ...UPDATER) && has(env, "GITHUB_REPOSITORY"),
    macSigned,
    macNotarized: macSigned && has(env, ...APPLE_NOTARIZE),
    windowsSigned: has(env, ...AZURE),
  };
}

/** The Trusted Signing command NSIS and Tauri run for each file (%1). Names are checked: they end up in a command. */
export function signCommand(endpoint, account, profile) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.pathname.length > 1 || url.search) {
    throw new Error("AZURE_SIGNING_ENDPOINT must be like https://<region>.codesigning.azure.net");
  }
  for (const [name, value] of [
    ["AZURE_SIGNING_ACCOUNT", account],
    ["AZURE_SIGNING_PROFILE", profile],
  ]) {
    if (!/^[A-Za-z0-9-]+$/.test(value)) throw new Error(`${name} may contain only letters, digits and dashes`);
  }
  return `trusted-signing-cli -e ${url.origin} -a ${account} -c ${profile} %1`;
}

/** Extra `tauri build --config` settings for this OS ("Windows" or "macOS", as RUNNER_OS names them). */
export function buildConfig(env, os) {
  const s = status(env);
  const config = {};
  if (s.updater) {
    config.bundle = { createUpdaterArtifacts: true };
    config.plugins = {
      updater: {
        pubkey: env.UPDATER_PUBKEY.trim(),
        endpoints: [`https://github.com/${env.GITHUB_REPOSITORY}/releases/latest/download/latest.json`],
        windows: { installMode: "passive" },
      },
    };
  }
  if (os === "Windows" && s.windowsSigned) {
    config.bundle = {
      ...config.bundle,
      windows: {
        signCommand: signCommand(env.AZURE_SIGNING_ENDPOINT, env.AZURE_SIGNING_ACCOUNT, env.AZURE_SIGNING_PROFILE),
      },
    };
  }
  return config;
}

/** Secrets the Tauri CLI should see on this OS. Unset ones are left out: an empty APPLE_CERTIFICATE fails the build. */
export function forwardedSecrets(env, os) {
  const s = status(env);
  const names = [];
  if (s.updater) names.push("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
  if (os === "macOS" && s.macSigned) names.push(...APPLE_SIGN);
  if (os === "macOS" && s.macNotarized) names.push(...APPLE_NOTARIZE);
  if (os === "Windows" && s.windowsSigned) names.push("AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID");
  return names.filter((n) => has(env, n));
}

/** Lines for a GITHUB_ENV / GITHUB_OUTPUT file; multi-line values use a delimiter that is not in the value. */
export function envFileLines(pairs) {
  return pairs
    .map(([name, value]) => {
      let delim = "EOF_RELEASE_CONFIG";
      while (value.includes(delim)) delim += "_";
      return `${name}<<${delim}\n${value}\n${delim}\n`;
    })
    .join("");
}

export function releaseNotes(env, tag) {
  const s = status(env);
  const lines = [
    `Claude Manager ${tag}`,
    "",
    "Windows: download the `-setup.exe` installer. macOS 12 or later: download the `.dmg` (Apple Silicon and Intel).",
    "Claude Code must be installed: https://code.claude.com/docs/en/setup",
  ];
  const notes = [];
  if (!s.windowsSigned) {
    notes.push(
      'The Windows installer is not code-signed. SmartScreen may say "Windows protected your PC": choose More info > Run anyway.',
    );
  }
  if (!s.macSigned) {
    notes.push(
      'The macOS app is not signed with a Developer ID. After the first attempt to open it, go to System Settings > Privacy & Security and choose Open Anyway, or run `xattr -dr com.apple.quarantine "/Applications/Claude Manager.app"`.',
    );
  } else if (!s.macNotarized) {
    notes.push("The macOS app is signed but not notarized: Gatekeeper may ask before the first launch.");
  }
  if (!s.updater) notes.push("In-app updates are off in this build: install new versions by hand.");
  if (notes.length) lines.push("", "Known limitations of this build:", ...notes.map((n) => `- ${n}`));
  lines.push("", "Changes: see CHANGELOG.md.");
  return `${lines.join("\n")}\n`;
}

function main([command, arg]) {
  const env = process.env;
  if (command === "notes" && arg) {
    process.stdout.write(releaseNotes(env, arg));
    return;
  }
  if (command === "build" && arg) {
    const os = env.RUNNER_OS ?? "";
    writeFileSync(arg, `${JSON.stringify(buildConfig(env, os), null, 2)}\n`);
    const s = status(env);
    if (env.GITHUB_OUTPUT) {
      appendFileSync(
        env.GITHUB_OUTPUT,
        envFileLines([
          ["config", arg],
          ["trusted_signing", String(os === "Windows" && s.windowsSigned)],
        ]),
      );
    }
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, envFileLines(forwardedSecrets(env, os).map((n) => [n, env[n]])));
    console.log(
      `release config for ${os}: updater ${s.updater ? "on" : "off"}, ` +
        (os === "macOS"
          ? `Developer ID signing ${s.macSigned ? "on" : "off"}, notarization ${s.macNotarized ? "on" : "off"}`
          : `Trusted Signing ${s.windowsSigned ? "on" : "off"}`),
    );
    return;
  }
  console.error("usage: node scripts/release-config.mjs build <out.json> | notes <tag>");
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
