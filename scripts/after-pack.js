"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

// electron-builder skips macOS code signing entirely when no Developer ID
// certificate is available (see app-builder-lib macPackager: it returns early
// before signing). That leaves the prebuilt Electron binary's own signature in
// place — ad-hoc, "linker-signed", with Identifier=Electron instead of our
// bundle id. A bundle whose code-signature identifier doesn't match its
// CFBundleIdentifier confuses macOS Launch Services and is fragile across
// reinstalls.
//
// This afterPack hook runs before that skipped signing step, so we re-sign the
// app ad-hoc ourselves. We deliberately omit --identifier: with --deep, codesign
// derives each nested bundle's identifier from its own Info.plist, so the app
// becomes com.coreypud.lappods and the helpers keep their own ids.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
