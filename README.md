# Brandon's Board — Nightly Memory Sync Agent

Runs every night at 11PM, reads your Supabase dashboard data, and writes structured memory documents using Anthropic's Managed Agents Memory Store API. Memory persists across all future Claude sessions automatically.

## What it does

1. Pulls completed tasks, brain dumps, and client pipeline from Supabase
2. Starts a Claude Managed Agent session with your persistent Memory Store attached
3. Agent writes structured docs:
   - `/daily-logs/YYYY-MM-DD.md` — what you did today + tomorrow's focus
   - `/clients.md` — updated client pipeline
   - `/goals.md` — patterns and insights over time
4. Emails a digest to brandonginartebusiness@gmail.com
5. Memory persists — every future Claude conversation inherits this context

## Setup

### Option A — Run locally with cron

```bash
# Clone or copy this folder
cd brandons_board_agent

# Schedule with cron (runs at 11PM every night)
crontab -e
# Add this line:
0 23 * * * cd /path/to/brandons_board_agent && node agent.js >> sync.log 2>&1
```

### Option B — GitHub Actions (recommended, zero maintenance)

1. Create a new GitHub repo (can be private)
2. Push this folder to it
3. The `.github/workflows/nightly-sync.yml` will run automatically every night at 11PM ET
4. Trigger manually anytime via Actions → Run workflow

## First run

On first run, the agent will:
- Create a new Memory Store (ID saved to `memory_store_id.txt`)
- Create a new Agent (ID saved to `agent_id.txt`)
- Seed the store with your profile, clients, and finances
- Run the first daily sync

On subsequent runs it reuses the same store and agent — memory accumulates over time.

## Files created by the agent

```
memory_store_id.txt   # Anthropic Memory Store ID (keep this!)
agent_id.txt          # Anthropic Agent ID (keep this!)
sync.log              # Run logs (if using cron)
```

## Credentials

All credentials are baked in for Brandon's setup:
- Anthropic API key
- Supabase (brandons-board project)
- Resend API key
