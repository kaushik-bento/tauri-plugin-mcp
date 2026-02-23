#!/usr/bin/env node
/**
 * MCP Protocol Smoke Test
 *
 * Spawns the MCP server, sends initialize + tools/list over stdio,
 * and validates that all 15 tools are registered with correct schemas.
 *
 * Run:  node test/smoke-test.mjs
 * (from mcp-server-ts/ directory, after `npx tsc`)
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

// ── Expectations ──────────────────────────────────────────────────────

const EXPECTED_TOOL_COUNT = 15;

const EXPECTED_TOOLS = [
  "take_screenshot",
  "execute_js",
  "get_dom",
  "manage_window",
  "manage_local_storage",
  "simulate_text_input",
  "simulate_mouse_movement",
  "get_element_position",
  "send_text_to_element",
  "get_page_map",
  "get_page_state",
  "navigate_back",
  "scroll_page",
  "fill_form",
  "wait_for",
];

// Tools whose selector_type enum MUST include "ref"
const TOOLS_WITH_REF_SELECTOR = ["get_element_position", "send_text_to_element"];

// Specific schema property checks:  tool -> param -> assertion
const SCHEMA_CHECKS = {
  get_page_map: {
    params: [
      "window_label", "include_content", "interactive_only",
      "scope_selector", "max_depth", "delta", "wait_for_stable",
      "quiet_ms", "max_wait_ms", "timeout_secs",
    ],
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  get_page_state: {
    params: ["window_label"],
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  navigate_back: {
    params: ["window_label", "direction", "delta"],
    annotations: { destructiveHint: true },
  },
  scroll_page: {
    params: ["window_label", "direction", "amount", "to_ref", "to_top", "to_bottom"],
    annotations: { destructiveHint: false },
  },
  fill_form: {
    params: ["window_label", "fields", "submit_ref"],
    annotations: { destructiveHint: true },
  },
  wait_for: {
    params: ["window_label", "text", "selector", "ref", "state", "timeout_ms"],
    annotations: { readOnlyHint: true },
  },
  get_element_position: {
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

let failures = 0;

function pass(msg) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  failures++;
}

function check(condition, passMsg, failMsg) {
  if (condition) pass(passMsg);
  else fail(failMsg);
}

// ── MCP Protocol Communication ───────────────────────────────────────

function sendJsonRpc(proc, id, method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  proc.stdin.write(msg + "\n");
}

async function collectResponses(proc, expectedCount, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const responses = [];
    let buffer = "";

    const timer = setTimeout(() => {
      reject(new Error(`Timeout: got ${responses.length}/${expectedCount} responses in ${timeoutMs}ms. Buffer: ${buffer}`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      // MCP messages are newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          responses.push(JSON.parse(trimmed));
        } catch {
          // skip non-JSON lines (e.g. logging)
        }
        if (responses.length >= expectedCount) {
          clearTimeout(timer);
          resolve(responses);
        }
      }
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1mMCP Protocol Smoke Test\x1b[0m\n");

  // Spawn server — set TAURI_MCP_SOCKET to a dummy value so it doesn't
  // try to connect to a real socket (it will fail to connect but that's
  // fine — we only need tool registration to work)
  const proc = spawn("node", ["build/index.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Prevent socket connection attempts from blocking
      TAURI_MCP_TRANSPORT: "tcp",
      TAURI_MCP_TCP_HOST: "127.0.0.1",
      TAURI_MCP_TCP_PORT: "0", // invalid port triggers fast failure
    },
  });

  // Collect stderr for debugging
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    // Send initialize + tools/list
    const responsePromise = collectResponses(proc, 2);

    sendJsonRpc(proc, 1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.1.0" },
    });

    // Small delay to let initialize complete before sending next request
    await new Promise((r) => setTimeout(r, 500));

    // Send initialized notification (required by MCP protocol)
    const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    proc.stdin.write(notif + "\n");

    await new Promise((r) => setTimeout(r, 200));

    sendJsonRpc(proc, 2, "tools/list", {});

    const responses = await responsePromise;

    // ── Validate initialize response ───────────────────────────────
    console.log("1. Initialize response:");

    const initResp = responses.find((r) => r.id === 1);
    check(initResp, "Got initialize response", "No initialize response");

    if (initResp?.result) {
      const { serverInfo } = initResp.result;
      check(
        serverInfo?.name === "tauri-mcp",
        `Server name: ${serverInfo?.name}`,
        `Unexpected server name: ${serverInfo?.name}`
      );
      // instructions may be at result.instructions or result.serverInfo.instructions
      const instructions = initResp.result.instructions ?? serverInfo?.instructions;
      check(
        typeof instructions === "string" && instructions.includes("get_page_map"),
        `Server instructions present and mentions get_page_map`,
        `Missing or incomplete server instructions: ${instructions}`
      );
    } else {
      fail(`Initialize result missing: ${JSON.stringify(initResp)}`);
    }

    // ── Validate tools/list response ───────────────────────────────
    console.log("\n2. Tools list:");

    const toolsResp = responses.find((r) => r.id === 2);
    check(toolsResp, "Got tools/list response", "No tools/list response");

    const tools = toolsResp?.result?.tools || [];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    const toolNames = tools.map((t) => t.name).sort();

    check(
      tools.length === EXPECTED_TOOL_COUNT,
      `Tool count: ${tools.length}`,
      `Expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}: [${toolNames.join(", ")}]`
    );

    // Check all expected tools are present
    console.log("\n3. Expected tools present:");
    for (const name of EXPECTED_TOOLS) {
      check(
        name in toolMap,
        name,
        `MISSING: ${name}`
      );
    }

    // Check no unexpected tools
    const unexpected = toolNames.filter((n) => !EXPECTED_TOOLS.includes(n));
    check(
      unexpected.length === 0,
      "No unexpected tools",
      `Unexpected tools: [${unexpected.join(", ")}]`
    );

    // ── Validate ref selector ──────────────────────────────────────
    console.log("\n4. 'ref' in selector_type enums:");
    for (const toolName of TOOLS_WITH_REF_SELECTOR) {
      const tool = toolMap[toolName];
      if (!tool) { fail(`${toolName}: tool not found`); continue; }

      const selectorProp = tool.inputSchema?.properties?.selector_type;
      const enumValues = selectorProp?.enum || [];
      check(
        enumValues.includes("ref"),
        `${toolName}: selector_type includes 'ref' → [${enumValues.join(", ")}]`,
        `${toolName}: selector_type missing 'ref' → [${enumValues.join(", ")}]`
      );
    }

    // ── Validate schema properties and annotations ─────────────────
    console.log("\n5. Schema property and annotation checks:");
    for (const [toolName, checks] of Object.entries(SCHEMA_CHECKS)) {
      const tool = toolMap[toolName];
      if (!tool) { fail(`${toolName}: tool not found`); continue; }

      // Check expected params exist in inputSchema
      if (checks.params) {
        const schemaProps = Object.keys(tool.inputSchema?.properties || {});
        const missing = checks.params.filter((p) => !schemaProps.includes(p));
        check(
          missing.length === 0,
          `${toolName}: all ${checks.params.length} params present`,
          `${toolName}: missing params [${missing.join(", ")}] (has: [${schemaProps.join(", ")}])`
        );
      }

      // Check annotations
      if (checks.annotations) {
        const ann = tool.annotations || {};
        for (const [key, expected] of Object.entries(checks.annotations)) {
          check(
            ann[key] === expected,
            `${toolName}: ${key} = ${ann[key]}`,
            `${toolName}: ${key} expected ${expected}, got ${ann[key]}`
          );
        }
      }
    }

    // ── Validate descriptions mention key concepts ─────────────────
    console.log("\n6. Description quality checks:");

    const domTool = toolMap["get_dom"];
    if (domTool) {
      check(
        domTool.description.includes("get_page_map") || domTool.description.includes("large"),
        "get_dom: warns about size / recommends get_page_map",
        `get_dom: description lacks size warning: "${domTool.description.substring(0, 80)}..."`
      );
    }

    const textInputTool = toolMap["simulate_text_input"];
    if (textInputTool) {
      check(
        textInputTool.description.includes("send_text_to_element") || textInputTool.description.includes("focused"),
        "simulate_text_input: mentions send_text_to_element or focused element",
        `simulate_text_input: description unclear: "${textInputTool.description.substring(0, 80)}..."`
      );
    }

    const sendTextTool = toolMap["send_text_to_element"];
    if (sendTextTool) {
      check(
        sendTextTool.description.includes("ref") || sendTextTool.description.includes("get_page_map"),
        "send_text_to_element: mentions ref or get_page_map workflow",
        `send_text_to_element: description lacks ref guidance: "${sendTextTool.description.substring(0, 80)}..."`
      );
    }

    const getPosTool = toolMap["get_element_position"];
    if (getPosTool) {
      check(
        getPosTool.description.includes("ref") || getPosTool.description.includes("get_page_map"),
        "get_element_position: mentions ref or get_page_map workflow",
        `get_element_position: description lacks ref guidance: "${getPosTool.description.substring(0, 80)}..."`
      );
    }

  } finally {
    proc.kill();
    // Wait for process to actually exit
    await once(proc, "exit").catch(() => {});
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(50));
  if (failures === 0) {
    console.log(`\x1b[32m\x1b[1mAll checks passed.\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failures} check(s) failed.\x1b[0m\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n\x1b[31mFatal error:\x1b[0m", err.message);
  process.exitCode = 1;
});
