// Tests for the release scripts: node --test scripts/ (run by the release workflow before building).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkVersions, isNumericVersion, readVersions, setVersion, tagVersion } from "./bump-version.mjs";
import { encodePng, render } from "./make-icons.mjs";
import { buildConfig, envFileLines, forwardedSecrets, releaseNotes, signCommand, status } from "./release-config.mjs";

const texts = {
  cargoToml:
    '[package]\nname = "claude-manager"\nversion = "0.1.0"\nauthors = ["x"]\n\n[dependencies]\nfoo = { version = "9.9.9" }\n',
  cargoLock:
    'version = 4\n\n[[package]]\nname = "bar"\nversion = "1.0.0"\n\n[[package]]\nname = "claude-manager"\nversion = "0.1.0"\ndependencies = []\n',
  packageJson: '{\n  "name": "claude-manager",\n  "version": "0.1.0",\n  "devDependencies": { "x": "1.0.0" }\n}\n',
};

describe("bump-version", () => {
  it("accepts only numeric X.Y.Z versions and vX.Y.Z tags", () => {
    assert.ok(isNumericVersion("1.20.3"));
    assert.ok(!isNumericVersion("1.2.3-rc.1"));
    assert.ok(!isNumericVersion("01.2.3"));
    assert.equal(tagVersion("v1.2.3"), "1.2.3");
    assert.equal(tagVersion("1.2.3"), null);
    assert.equal(tagVersion("v1.2.3-rc"), null);
  });

  it("reads the package version, not a dependency's", () => {
    assert.deepEqual(readVersions(texts), { cargo: "0.1.0", lock: "0.1.0", package: "0.1.0" });
  });

  it("sets the version in all three files and nothing else", () => {
    const next = setVersion(texts, "1.2.0");
    assert.deepEqual(readVersions(next), { cargo: "1.2.0", lock: "1.2.0", package: "1.2.0" });
    assert.ok(next.cargoToml.includes('foo = { version = "9.9.9" }'));
    assert.ok(next.cargoLock.includes('name = "bar"\nversion = "1.0.0"'));
    assert.throws(() => setVersion(texts, "1.2"), /numeric/);
  });

  it("reports drift and a tag that does not match", () => {
    assert.deepEqual(checkVersions(texts), []);
    assert.deepEqual(checkVersions(texts, "v0.1.0"), []);
    assert.match(checkVersions(texts, "v0.2.0")[0], /does not match/);
    assert.match(checkVersions(texts, "release-1")[0], /not of the form/);
    const drift = { ...texts, packageJson: texts.packageJson.replace("0.1.0", "0.0.9") };
    assert.match(checkVersions(drift)[0], /package\.json has 0\.0\.9/);
  });
});

describe("release-config", () => {
  const full = {
    GITHUB_REPOSITORY: "owner/claude-manager",
    UPDATER_PUBKEY: "pubkey-text",
    TAURI_SIGNING_PRIVATE_KEY: "private",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "pw",
    APPLE_CERTIFICATE: "cert",
    APPLE_CERTIFICATE_PASSWORD: "pw",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: X (TEAM)",
    APPLE_ID: "a@b.c",
    APPLE_PASSWORD: "app-pw",
    APPLE_TEAM_ID: "TEAM",
    AZURE_CLIENT_ID: "id",
    AZURE_CLIENT_SECRET: "secret",
    AZURE_TENANT_ID: "tenant",
    AZURE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
    AZURE_SIGNING_ACCOUNT: "acct",
    AZURE_SIGNING_PROFILE: "profile-1",
  };

  it("turns each part on only when all of its inputs exist", () => {
    assert.deepEqual(status({}), { updater: false, macSigned: false, macNotarized: false, windowsSigned: false });
    assert.deepEqual(status(full), { updater: true, macSigned: true, macNotarized: true, windowsSigned: true });
    assert.equal(status({ ...full, APPLE_TEAM_ID: "" }).macNotarized, false);
    assert.equal(status({ ...full, UPDATER_PUBKEY: " " }).updater, false);
  });

  it("builds no extra config without secrets", () => {
    assert.deepEqual(buildConfig({}, "Windows"), {});
    assert.deepEqual(forwardedSecrets({}, "macOS"), []);
  });

  it("adds updater artifacts, the endpoint and Windows signing when configured", () => {
    const win = buildConfig(full, "Windows");
    assert.equal(win.bundle.createUpdaterArtifacts, true);
    assert.deepEqual(win.plugins.updater.endpoints, [
      "https://github.com/owner/claude-manager/releases/latest/download/latest.json",
    ]);
    assert.equal(
      win.bundle.windows.signCommand,
      "trusted-signing-cli -e https://weu.codesigning.azure.net -a acct -c profile-1 %1",
    );
    assert.equal(buildConfig(full, "macOS").bundle.windows, undefined);
  });

  it("forwards only the secrets that apply on the OS", () => {
    assert.deepEqual(forwardedSecrets(full, "macOS"), [
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
    ]);
    assert.ok(!forwardedSecrets(full, "Windows").some((n) => n.startsWith("APPLE_")));
    assert.ok(
      !forwardedSecrets({ ...full, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" }, "Windows").includes(
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
      ),
    );
  });

  it("refuses names that could change the signing command", () => {
    assert.throws(() => signCommand("http://x.codesigning.azure.net", "a", "b"), /https/);
    assert.throws(() => signCommand("https://x.codesigning.azure.net", "a & calc", "b"), /letters/);
  });

  it("writes multi-line values with a safe delimiter", () => {
    assert.equal(envFileLines([["A", "x\ny"]]), "A<<EOF_RELEASE_CONFIG\nx\ny\nEOF_RELEASE_CONFIG\n");
    assert.match(envFileLines([["A", "EOF_RELEASE_CONFIG"]]), /^A<<EOF_RELEASE_CONFIG_\n/);
  });

  it("says in the notes what this build lacks", () => {
    const bare = releaseNotes({}, "v1.0.0");
    assert.match(bare, /^Claude Manager v1\.0\.0\n/);
    assert.match(bare, /not code-signed/);
    assert.match(bare, /Open Anyway/);
    assert.match(bare, /In-app updates are off/);
    assert.doesNotMatch(releaseNotes(full, "v1.0.0"), /Known limitations/);
  });
});

describe("make-icons", () => {
  it("writes a valid RGBA PNG with anti-aliased transparent edges", () => {
    const pixels = render(8, 8, [{ shape: (x, y) => Math.hypot(x - 4, y - 4) - 3, color: [255, 0, 0, 1] }]);
    assert.equal(pixels[(4 * 8 + 4) * 4 + 3], 255); // centre opaque
    assert.equal(pixels[3], 0); // corner transparent
    const png = encodePng(8, pixels);
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
    assert.equal(png.readUInt32BE(16), 8);
    assert.equal(png[25], 6);
  });
});
