# Openclaw Setup Analysis
> For a research agent to compare against similar approaches and identify improvements.

---

## What This Is

A self-hosted AI agent runtime ([openclaw](https://github.com/coollabsio/openclaw)) where **agent identities and configs are defined as Markdown files in an Obsidian vault**, synced via git, and applied automatically on every container deploy. The vault is the source of truth for agents. Infrastructure config lives in env vars + a baked JSON base.

**Vault repo**: `github.com/olwiba/vault`
**This repo**: `github.com/olwiba/openclaw` (fork of `coollabsio/openclaw`)

---

## Full Flow: Markdown → Running Agent Config

```
Obsidian (local editor)
  └─ agents/
       └─ <agent-name>/
            ├─ SOUL.md      ← system prompt (markdown body) + identity frontmatter
            └─ CONFIG.md    ← model, tools, sandbox, workspace (YAML frontmatter)

  git push → github.com/olwiba/vault
                    ↓
          git pull to host: /opt/seekers-vault
                    ↓  (Docker volume mount, read-write)
          container: /data/workspace/seekers-vault
                    ↓
          vault-sync.js (runs at container startup, after configure.js)
                    ↓
          /data/.openclaw/openclaw.json  ← live agent config openclaw reads
```

### What vault-sync.js does with the Markdown

1. Walks `agents/` recursively, finds dirs containing `SOUL.md` or `CONFIG.md`
2. Parses YAML frontmatter from both files (custom parser, no deps)
3. **Filters to `status: active` only** — setup/paused/inactive agents are skipped
4. Maps fields to openclaw config:

| Vault file | Field | → `openclaw.json` path |
|---|---|---|
| `SOUL.md` | markdown body | `agents.<id>.instructions` |
| `CONFIG.md` | `model.primary` | `agents.<id>.model.primary` |
| `CONFIG.md` | `model.fallback` | `agents.<id>.model.fallback` |
| `CONFIG.md` | `workspace` | `agents.<id>.workspace` |
| `CONFIG.md` | `tools.allow` | `agents.<id>.tools.allow` |
| `CONFIG.md` | `tools.deny` | `agents.<id>.tools.deny` |
| `CONFIG.md` | `sandbox.mode` | `agents.<id>.sandbox.mode` |
| `CONFIG.md` | `sandbox.scope` | `agents.<id>.sandbox.scope` |

5. Deep-merges into existing config (vault adds/overrides, doesn't wipe)
6. Writes `.vault-sync-manifest.json` back into the vault root (sync receipt)

---

## Full Config Layering (startup order, lowest → highest precedence)

```
my-openclaw.json (baked into image at build)
        ↓ deep-merge
Persisted config (openclaw-data Docker volume, survives restarts)
        ↓ deep-merge
Env vars → configure.js (runs at container start)
        ↓ deep-merge
vault-sync.js (agent configs from Obsidian vault)
        ↓
/data/.openclaw/openclaw.json  ← final runtime config
```

**`my-openclaw.json`** (baked into image) currently sets:
- Gateway trusted proxies (127.0.0.1, 172.16.0.0/12 for Tailscale)
- Control UI allowed origins (Tailscale domain)
- Memory compaction + experimental session memory search

---

## Infrastructure: What's Running

- **openclaw gateway** — AI agent runtime, port 18789 (internal)
- **nginx** — reverse proxy on port 8080, handles HTTP basic auth, proxies to gateway
- **browser sidecar** — `coollabsio/openclaw-browser` (kasmweb/chrome), CDP on 9222, VNC proxied at `/browser/`
- **Tailscale** — external access, trusted proxy configured in `my-openclaw.json`
- **SSH keys** — host `/root/.ssh` mounted RO into container (for agent git operations)
- **Vault** — host `/opt/seekers-vault` mounted RW into container

---

## Key Differences from Vanilla Openclaw

| This setup | Upstream default |
|---|---|
| Builds from source (custom `Dockerfile`) | Pulls `coollabsio/openclaw:latest` |
| `my-openclaw.json` baked into image | No baked config |
| **vault-sync.js** — Markdown → agent config (custom) | No vault concept |
| Agents defined as Obsidian Markdown | Agents configured via UI or JSON only |
| SSH keys mounted into container | No SSH |
| Tailscale proxy + origin allowlist | No proxy config |
| Experimental session memory search on | Off by default |
| Vault volume mounted (RW) | No vault |
| Hooks/webhook support enabled | Optional, not configured |

---

## The Core Idea (for research context)

**GitOps for AI agents via a Markdown knowledge base.**
Obsidian is used as the human interface to define agents — you write a system prompt in Markdown, set config in frontmatter, commit, and it's live on next deploy. No UI-based agent creation, no raw JSON editing. The vault doubles as a knowledge base (Obsidian graph, links, notes) and as the agent config source of truth.

**Related concepts to research:**
- GitOps / config-as-code for AI agents
- Agent definition via Markdown/frontmatter (vs JSON/YAML config files)
- Obsidian as an AI ops interface
- Vault-backed agent identity management
- Self-hosted LLM agent orchestration (similar: Open WebUI pipelines, AgentOps, n8n AI agents, Langchain agent configs)

---

## Current Limitations / Open Questions

- **vault-sync runs once at startup** — vault changes need a container restart; no live reload / watch mode
- **No auto-pull from git** — host `/opt/seekers-vault` must be kept in sync with GitHub separately (manual, cron, or webhook trigger)
- **`my-openclaw.json` baked into image** — gateway/memory settings require a full image rebuild to change
- **Vault mounted RW** — vault-sync writes back a manifest; fine, but Obsidian will surface the JSON file
- **No agent lifecycle from vault** — can't create/delete agents at runtime; only merges on restart
- **`status: active` is a manual gate** — no automated promotion/demotion based on agent health/heartbeat (HEARTBEAT.md is read but not acted on)
