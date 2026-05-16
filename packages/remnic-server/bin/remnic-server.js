#!/usr/bin/env node
const commandName = process.argv[1]?.endsWith("engram-server") ? "engram-server" : "remnic-server";

const help = `
${commandName} - Standalone Remnic memory server

Usage:
  ${commandName} [options]

Options:
  --config <path>     Path to config file (default: remnic.config.json)
  --host <addr>       Bind address (default: 127.0.0.1)
  --port <number>     Port number (default: 4318)
  --auth-token <tok>  Bearer token for auth (or set REMNIC_AUTH_TOKEN)
  --help              Show this help
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

const { cliMain } = await import("../dist/index.js");

await cliMain().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
