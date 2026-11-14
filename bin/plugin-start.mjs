#!/usr/bin/env node

/**
 * Claude Code plugin entrypoint.
 *
 * Installs production dependencies on first launch when the plugin directory
 * has no node_modules, then starts the MCP server in this same process.
 * npm output stays off stdout so it cannot corrupt the MCP stream.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.GROK_BACKEND) {
  process.env.GROK_BACKEND = "cli";
}

const sdkManifest = join(root, "node_modules", "@modelcontextprotocol", "sdk", "package.json");

try {
  await access(sdkManifest);
} catch {
  await installDependencies(root);
}

await import(pathToFileURL(join(root, "grok-mcp.mjs")).href);

/**
 * @param {string} cwd
 * @returns {Promise<void>}
 */
function installDependencies(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      ["install", "--omit=dev", "--no-audit", "--no-fund"],
      {
        cwd,
        env: process.env,
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed with status ${code}`));
    });
  });
}
