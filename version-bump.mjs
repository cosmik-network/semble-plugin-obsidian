// Run via `npm version <patch|minor|major>`: copies the new package.json
// version into manifest.json and records it with its minAppVersion in
// versions.json. npm then commits these files and tags the commit.
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
