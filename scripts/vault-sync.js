#!/usr/bin/env node
// Vault-sync reconciler — parses SOUL.md/CONFIG.md from the vault and
// merges agent configs into openclaw.json.
// No npm dependencies — uses only Node built-ins (like configure.js).

const fs = require("fs");
const path = require("path");

const STATE_DIR = (process.env.OPENCLAW_STATE_DIR || "/data/.openclaw").replace(/\/+$/, "");
const VAULT_PATH = (process.env.VAULT_PATH || "").replace(/\/+$/, "");
const CONFIG_FILE = process.env.OPENCLAW_CONFIG_PATH || path.join(STATE_DIR, "openclaw.json");

if (!VAULT_PATH) {
  console.error("[vault-sync] ERROR: VAULT_PATH is not set.");
  process.exit(1);
}

if (!fs.existsSync(VAULT_PATH)) {
  console.error(`[vault-sync] ERROR: VAULT_PATH does not exist: ${VAULT_PATH}`);
  process.exit(1);
}

const AGENTS_DIR = path.join(VAULT_PATH, "agents");

console.log("[vault-sync] vault path:", VAULT_PATH);
console.log("[vault-sync] config file:", CONFIG_FILE);

// ── YAML Frontmatter Parser ─────────────────────────────────────────────────
// Handles nested objects, arrays, inline comments. Enough for CONFIG.md/SOUL.md.

function parseFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };

  const yamlBlock = match[1];
  const body = match[2];
  const data = parseYamlBlock(yamlBlock);
  return { data, body };
}

function parseYamlBlock(yamlBlock) {
  const lines = yamlBlock.split("\n");
  const root = {};
  const stack = [{ obj: root, indent: -1, key: null }];
  let pendingArrayKey = null;   // key that might receive array items
  let pendingArrayParent = null; // parent object of the pending key
  let inArray = false;
  let arrayItems = [];

  for (const rawLine of lines) {
    // Strip inline comments (but not inside quoted strings)
    const line = rawLine.replace(/\s+#[^"']*$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // Check if this is an array item
    const arrayMatch = line.match(/^(\s*)-\s+(.*)$/);
    if (arrayMatch) {
      const val = arrayMatch[2].trim().replace(/^["']|["']$/g, "");
      arrayItems.push(val);
      inArray = true;
      continue;
    }

    // If we were collecting array items and hit a non-array line, flush
    if (inArray && pendingArrayKey && pendingArrayParent) {
      pendingArrayParent[pendingArrayKey] = [...arrayItems];
      // Also pop the empty object we may have pushed for this key
      if (stack.length > 1 && stack[stack.length - 1].key === pendingArrayKey) {
        stack.pop();
      }
      arrayItems = [];
      inArray = false;
      pendingArrayKey = null;
      pendingArrayParent = null;
    }

    // Key-value line
    const kvMatch = line.match(/^(\s*)([\w][\w.-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const keyIndent = kvMatch[1].length;
    const key = kvMatch[2];
    const rawVal = kvMatch[3].trim();

    // Pop stack to find parent at correct indent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= keyIndent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (rawVal === "" || rawVal === "|" || rawVal === ">") {
      // This key introduces a nested object or array — we won't know until
      // we see the next lines. Tentatively create an object; if array items
      // follow, we'll replace it.
      parent[key] = {};
      stack.push({ obj: parent[key], indent: keyIndent, key });
      pendingArrayKey = key;
      pendingArrayParent = parent;
    } else if (rawVal === "[]") {
      parent[key] = [];
      pendingArrayKey = null;
      pendingArrayParent = null;
    } else if (rawVal === "null" || rawVal === "~") {
      parent[key] = null;
      pendingArrayKey = null;
      pendingArrayParent = null;
    } else if (rawVal === "true") {
      parent[key] = true;
      pendingArrayKey = null;
      pendingArrayParent = null;
    } else if (rawVal === "false") {
      parent[key] = false;
      pendingArrayKey = null;
      pendingArrayParent = null;
    } else if (/^-?\d+$/.test(rawVal)) {
      parent[key] = parseInt(rawVal, 10);
      pendingArrayKey = null;
      pendingArrayParent = null;
    } else if (/^-?\d+\.\d+$/.test(rawVal)) {
      parent[key] = parseFloat(rawVal);
      pendingArrayKey = null;
      pendingArrayParent = null;
    } else {
      parent[key] = rawVal.replace(/^["']|["']$/g, "");
      pendingArrayKey = null;
      pendingArrayParent = null;
    }
  }

  // Flush any trailing array
  if (inArray && pendingArrayKey && pendingArrayParent) {
    pendingArrayParent[pendingArrayKey] = [...arrayItems];
  }

  return root;
}

function setNestedValue(obj, key, value) {
  obj[key] = value;
}

// ── Deep merge (same as configure.js) ────────────────────────────────────────

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === "object" && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// ── Agent Discovery ──────────────────────────────────────────────────────────
// Recursively walks the agents/ directory tree looking for SOUL.md/CONFIG.md pairs.

function discoverAgents(dir, agents) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "reports" || entry.name === "status") continue;

    const agentDir = path.join(dir, entry.name);
    const soulPath = path.join(agentDir, "SOUL.md");
    const configPath = path.join(agentDir, "CONFIG.md");
    const heartbeatPath = path.join(agentDir, "HEARTBEAT.md");

    if (fs.existsSync(soulPath) || fs.existsSync(configPath)) {
      const agent = { dir: agentDir, dirName: entry.name };

      if (fs.existsSync(soulPath)) {
        const { data, body } = parseFrontmatter(fs.readFileSync(soulPath, "utf-8"));
        agent.soul = data;
        agent.systemPrompt = body.trim();
      }

      if (fs.existsSync(configPath)) {
        agent.config = parseFrontmatter(fs.readFileSync(configPath, "utf-8")).data;
      }

      if (fs.existsSync(heartbeatPath)) {
        agent.heartbeat = parseFrontmatter(fs.readFileSync(heartbeatPath, "utf-8")).data;
      }

      agent.id = agent.config?.id || agent.soul?.id || entry.name;
      agent.status = agent.config?.status || agent.soul?.status || "setup";
      agent.tier = agent.config?.tier || agent.soul?.tier || "unknown";

      agents.push(agent);
    }

    // Recurse into subdirectories (nested agent hierarchy)
    discoverAgents(agentDir, agents);
  }
}

// ── Generate OpenClaw agent config ───────────────────────────────────────────

function generateAgentConfig(agent) {
  const config = {};

  // Model configuration
  if (agent.config?.model) {
    config.model = {};
    if (agent.config.model.primary) config.model.primary = agent.config.model.primary;
    if (agent.config.model.fallback) config.model.fallback = agent.config.model.fallback;
  }

  // System prompt from SOUL.md body
  if (agent.systemPrompt) {
    config.instructions = agent.systemPrompt;
  }

  // Workspace
  if (agent.config?.workspace) {
    config.workspace = agent.config.workspace;
  }

  // Tools
  if (agent.config?.tools) {
    config.tools = {};
    if (agent.config.tools.allow) config.tools.allow = agent.config.tools.allow;
    if (agent.config.tools.deny) config.tools.deny = agent.config.tools.deny;
  }

  // Sandbox
  if (agent.config?.sandbox) {
    config.sandbox = {};
    if (agent.config.sandbox.mode) config.sandbox.mode = agent.config.sandbox.mode;
    if (agent.config.sandbox.scope) config.sandbox.scope = agent.config.sandbox.scope;
  }

  return config;
}

// ── Main ─────────────────────────────────────────────────────────────────────

// 1. Discover agents
const agents = [];
discoverAgents(AGENTS_DIR, agents);
console.log(`[vault-sync] discovered ${agents.length} agent(s)`);

for (const agent of agents) {
  console.log(`[vault-sync]   ${agent.id} (tier=${agent.tier}, status=${agent.status})`);
}

// 2. Filter to active agents only
const activeAgents = agents.filter(a => a.status === "active");
console.log(`[vault-sync] ${activeAgents.length} active agent(s) to sync`);

if (activeAgents.length === 0) {
  console.log("[vault-sync] no active agents found, skipping config merge");
} else {
  // 3. Load existing openclaw.json (written by configure.js)
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    console.log("[vault-sync] loaded existing config from", CONFIG_FILE);
  } catch {
    console.log("[vault-sync] no existing config found, starting fresh");
  }

  // 4. Ensure agents section exists
  if (!config.agents) config.agents = {};

  // 5. Generate and merge agent configs
  for (const agent of activeAgents) {
    const agentConfig = generateAgentConfig(agent);
    console.log(`[vault-sync] merging config for ${agent.id}`);

    if (!config.agents[agent.id]) {
      config.agents[agent.id] = agentConfig;
    } else {
      deepMerge(config.agents[agent.id], agentConfig);
    }
  }

  // 6. Write updated config
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log("[vault-sync] config written to", CONFIG_FILE);
}

// 7. Write sync manifest to vault
const manifest = {
  syncedAt: new Date().toISOString(),
  vaultPath: VAULT_PATH,
  agents: agents.map(a => ({
    id: a.id,
    tier: a.tier,
    status: a.status,
    hasSoul: !!a.soul,
    hasConfig: !!a.config,
    hasHeartbeat: !!a.heartbeat,
  })),
  activeCount: activeAgents.length,
  totalCount: agents.length,
};

const manifestPath = path.join(VAULT_PATH, ".vault-sync-manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log("[vault-sync] manifest written to", manifestPath);
console.log("[vault-sync] done");
