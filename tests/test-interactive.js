#!/usr/bin/env node
/**
 * Interactive test for Engram MCP server
 * Sends multiple requests and captures responses
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const requests = [
  // 1. Stats (empty)
  {
    name: "Stats (empty)",
    request: { method: "tools/call", params: { name: "stats", arguments: {} } },
  },
  // 2. Remember Sarah
  {
    name: "Remember Sarah background",
    request: {
      method: "tools/call",
      params: {
        name: "remember",
        arguments: {
          content: "Sarah Chen is the VP of Engineering at Acme Corp. She's allergic to shellfish, prefers window seats on flights, and is leading the Q1 product launch.",
          importance: 0.9,
        },
      },
    },
  },
  // 3. Remember Sarah preferences
  {
    name: "Remember Sarah preferences",
    request: {
      method: "tools/call",
      params: {
        name: "remember",
        arguments: {
          content: "Sarah prefers async communication over meetings. She's most productive in the mornings and usually blocks her calendar before 10am for deep work.",
          importance: 0.8,
        },
      },
    },
  },
  // 4. Remember John
  {
    name: "Remember John",
    request: {
      method: "tools/call",
      params: {
        name: "remember",
        arguments: {
          content: "John Martinez is a senior developer who reports to Sarah. He's an expert in backend systems and recently led the API redesign project.",
        },
      },
    },
  },
  // 5. Create relationship
  {
    name: "Relate Sarah and John",
    request: {
      method: "tools/call",
      params: {
        name: "relate",
        arguments: { from: "John Martinez", to: "Sarah Chen", relation: "reports_to" },
      },
    },
  },
  // 6. Add observation
  {
    name: "Observe Sarah allergy",
    request: {
      method: "tools/call",
      params: {
        name: "observe",
        arguments: {
          entity: "Sarah Chen",
          observation: "Has severe shellfish allergy - avoid all seafood restaurants for team events",
        },
      },
    },
  },
  // 7. Query entity
  {
    name: "Query Sarah entity",
    request: {
      method: "tools/call",
      params: { name: "query_entity", arguments: { entity: "Sarah Chen" } },
    },
  },
  // 8. Recall semantic
  {
    name: "Recall: Sarah's work preferences",
    request: {
      method: "tools/call",
      params: {
        name: "recall",
        arguments: { query: "How does Sarah prefer to work and communicate?" },
      },
    },
  },
  // 9. Recall by context
  {
    name: "Recall: Team lunch planning",
    request: {
      method: "tools/call",
      params: {
        name: "recall",
        arguments: { query: "What should I know when planning a team lunch?" },
      },
    },
  },
  // 10. List entities
  {
    name: "List person entities",
    request: {
      method: "tools/call",
      params: { name: "list_entities", arguments: { type: "person" } },
    },
  },
  // 11. Final stats
  {
    name: "Final stats",
    request: { method: "tools/call", params: { name: "stats", arguments: {} } },
  },
];

async function main() {
  console.log("=== Engram MCP Test Suite ===\n");

  // Start the MCP server
  const serverPath = path.join(__dirname, "..", "dist", "index.js");
  const server = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Capture stderr for logging
  server.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[Server] ${msg}`);
  });

  const rl = createInterface({
    input: server.stdout,
    crlfDelay: Infinity,
  });

  let responseResolve;
  let responsePromise;

  rl.on("line", (line) => {
    try {
      const response = JSON.parse(line);
      if (responseResolve) {
        responseResolve(response);
      }
    } catch (e) {
      // Ignore non-JSON lines
    }
  });

  // Wait for server to be ready
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Run each test
  let id = 1;
  for (const test of requests) {
    console.log(`\n--- Test ${id}: ${test.name} ---`);

    responsePromise = new Promise((resolve) => {
      responseResolve = resolve;
    });

    const request = {
      jsonrpc: "2.0",
      id: id++,
      ...test.request,
    };

    server.stdin.write(JSON.stringify(request) + "\n");

    try {
      const response = await Promise.race([
        responsePromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 10000)
        ),
      ]);

      if (response.error) {
        console.log(`Error: ${JSON.stringify(response.error)}`);
      } else if (response.result?.content?.[0]?.text) {
        const text = response.result.content[0].text;
        try {
          const parsed = JSON.parse(text);
          console.log(`Result: ${JSON.stringify(parsed, null, 2)}`);
        } catch {
          console.log(`Result: ${text}`);
        }
      } else {
        console.log(`Response: ${JSON.stringify(response, null, 2)}`);
      }
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }
  }

  // Cleanup
  console.log("\n=== Tests Complete ===");
  server.kill();
  process.exit(0);
}

main().catch(console.error);
