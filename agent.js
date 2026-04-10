/**
 * Brandon's Board — Nightly Memory Sync Agent
 * Uses Anthropic Managed Agents API with persistent Memory Stores
 *
 * Run this script nightly via cron, GitHub Actions, or any scheduler.
 * It will:
 *   1. Create a memory store once (or reuse existing)
 *   2. Start a managed agent session
 *   3. Agent reads Supabase, writes structured memory docs automatically
 *   4. Memory persists across all future Claude sessions
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = "https://lpobnfrdndeayttqfriz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_KEY = process.env.RESEND_KEY;
const RECIPIENT_EMAIL = "brandonginartebusiness@gmail.com";
const MEMORY_STORE_ID_FILE = "./memory_store_id.txt";

const BASE_HEADERS = {
  "x-api-key": ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json"
};

const fs = require("fs");

// ─── Supabase helpers ────────────────────────────────────────────────────────

async function sbFetch(path, query = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${query}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    }
  });
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error(`sbFetch(${path}${query}) returned non-array:`, data);
    return [];
  }
  return data;
}

async function fetchTodayData() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const iso = todayStart.toISOString();

  const [tasks, dumps, clients, finances] = await Promise.all([
    sbFetch("tasks", `?done=eq.true&done_at=gte.${iso}&order=done_at.asc`),
    sbFetch("brain_dumps", `?created_at=gte.${iso}&order=created_at.asc`),
    sbFetch("clients", "?order=id.asc"),
    sbFetch("finances", "?order=type.asc,id.asc")
  ]);

  return { tasks, dumps, clients, finances };
}

// ─── Memory store ────────────────────────────────────────────────────────────

async function getOrCreateMemoryStore() {
  // Reuse existing store ID if we have one saved
  if (fs.existsSync(MEMORY_STORE_ID_FILE)) {
    const id = fs.readFileSync(MEMORY_STORE_ID_FILE, "utf8").trim();
    console.log(`Using existing memory store: ${id}`);
    return id;
  }

  console.log("Creating new memory store...");
  const res = await fetch("https://api.anthropic.com/v1/memory_stores", {
    method: "POST",
    headers: BASE_HEADERS,
    body: JSON.stringify({
      name: "Brandon's Board Memory",
      description: "Persistent context for Brandon Ginarte — Rollinshotz entrepreneur in Miami. Tracks clients, tasks, finances, goals, and daily activity from Brandon's Board dashboard."
    })
  });

  const store = await res.json();
  console.log("Memory store full response:", JSON.stringify(store, null, 2));
  const storeId = store.id || store.store_id || store.memory_store_id;
  if (!storeId) throw new Error("Memory store creation failed — no id field found. Full response: " + JSON.stringify(store));
  fs.writeFileSync(MEMORY_STORE_ID_FILE, storeId);
  return storeId;
}

async function seedMemoryStore(storeId, data) {
  const { clients, finances } = data;
  const statusMap = { ret: "Retainer", con: "Contract", pro: "Prospect", clo: "Closed", sta: "Stalled" };

  // Seed initial profile if it doesn't exist yet
  const profileContent = `# Brandon Ginarte — Profile

- Full name: Brandon Ginarte
- Age: 21
- Location: Miami / Hialeah, Florida
- Business: Rollinshotz (@rollinshotz / rollinshotz.com)
- Services: Photography, videography, web design/development, marketing, lead generation
- Camera: Sony A6700, shoots S-Log3/S-Gamut3.Cine, edits in DaVinci Resolve Studio
- Stack: Claude.ai (planning), Cursor (execution), Vercel (deploy), Supabase, n8n, GitHub
- Email: brandonginartebusiness@gmail.com
`;

  const clientContent = `# Client Pipeline\n\n${clients.map(c =>
    `## ${c.name}\n- Status: ${statusMap[c.status] || c.status}\n- Next action: ${c.next_action || "None"}`
  ).join("\n\n")}`;

  const income = finances.filter(f => f.type === "income");
  const burn = finances.filter(f => f.type === "burn");
  const debt = finances.filter(f => f.type === "debt");

  const finContent = `# Finances\n\n## Income\n${income.map(f => `- ${f.name}: $${Number(f.amount).toLocaleString()}/mo`).join("\n")}\n\n## Subscriptions / Burn\n${burn.map(f => `- ${f.name}: $${Number(f.amount).toLocaleString()}/mo`).join("\n")}\n\n## Debt\n${debt.map(f => `- ${f.name}: $${Number(f.amount).toLocaleString()}`).join("\n")}`;

  const seeds = [
    { path: "/profile.md", content: profileContent },
    { path: "/clients.md", content: clientContent },
    { path: "/finances.md", content: finContent }
  ];

  for (const seed of seeds) {
    await fetch(`https://api.anthropic.com/v1/memory_stores/${storeId}/memories`, {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify({ ...seed, precondition: { type: "not_exists" } })
    });
  }

  console.log("Memory store seeded with initial data.");
}

// ─── Agent session ───────────────────────────────────────────────────────────

async function getOrCreateAgent() {
  const AGENT_ID_FILE = "./agent_id.txt";

  if (fs.existsSync(AGENT_ID_FILE)) {
    const id = fs.readFileSync(AGENT_ID_FILE, "utf8").trim();
    console.log(`Using existing agent: ${id}`);
    return id;
  }

  console.log("Creating agent...");
  const res = await fetch("https://api.anthropic.com/v1/agents", {
    method: "POST",
    headers: BASE_HEADERS,
    body: JSON.stringify({
      name: "Brandon's Board Daily Sync",
      model: "claude-sonnet-4-20250514",
      system_prompt: `You are Brandon Ginarte's personal productivity agent. Brandon is a 21-year-old creative entrepreneur in Miami running Rollinshotz — a photography, videography, web design, marketing, and lead generation business.

Your job when activated each night is to:
1. Review the data provided about today's activity (completed tasks, brain dumps, client status)
2. Update the memory store documents to reflect the latest state:
   - Write to /daily-logs/{DATE}.md with a summary of the day
   - Update /clients.md with any client status changes
   - Update /finances.md if anything changed
   - Update /goals.md with patterns or next steps you notice
3. Be concise, factual, and write in third person ("Brandon completed...")

Always check memory before writing to avoid duplication. Use memory_search to find relevant existing context.`
    })
  });

  const agent = await res.json();
  console.log("Agent created:", agent.id);
  fs.writeFileSync(AGENT_ID_FILE, agent.id);
  return agent.id;
}

async function runAgentSession(agentId, storeId, data) {
  const { tasks, dumps, clients } = data;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const dateSlug = new Date().toISOString().slice(0, 10);
  const statusMap = { ret: "Retainer", con: "Contract", pro: "Prospect", clo: "Closed", sta: "Stalled" };

  const taskLines = tasks.length
    ? tasks.map(t => `- [${t.tag}] ${t.text}`).join("\n")
    : "No tasks completed today.";

  const dumpLines = dumps.length
    ? dumps.map(d => `- ${d.text}`).join("\n")
    : "No brain dumps today.";

  const clientLines = clients.map(c =>
    `- ${c.name} [${statusMap[c.status] || c.status}]: ${c.next_action || "No action set"}`
  ).join("\n");

  const userMessage = `Today is ${today} (${dateSlug}).

Here is Brandon's activity from Brandon's Board today:

== TASKS COMPLETED (${tasks.length}) ==
${taskLines}

== BRAIN DUMPS (${dumps.length}) ==
${dumpLines}

== CURRENT CLIENT PIPELINE ==
${clientLines}

Please:
1. Write a daily log to /daily-logs/${dateSlug}.md summarizing what Brandon did today, key thoughts, and suggested focus for tomorrow
2. Update /clients.md to reflect the current pipeline state
3. Check /goals.md and add any patterns or insights worth tracking

Be concise. Write in third person.`;

  console.log("Starting agent session...");
  const sessionRes = await fetch("https://api.anthropic.com/v1/sessions", {
    method: "POST",
    headers: BASE_HEADERS,
    body: JSON.stringify({
      agent_id: agentId,
      resources: [
        {
          type: "memory_store",
          memory_store_id: storeId,
          access: "read_write",
          prompt: "Brandon's persistent context — profile, clients, finances, daily logs. Check before writing. Update after every session."
        }
      ]
    })
  });

  const session = await sessionRes.json();
  console.log("Session started:", session.id);

  // Send the user message as an event
  const eventRes = await fetch(`https://api.anthropic.com/v1/sessions/${session.id}/events`, {
    method: "POST",
    headers: BASE_HEADERS,
    body: JSON.stringify({
      type: "user",
      content: userMessage
    })
  });

  // Stream the response
  let fullText = "";
  const reader = eventRes.body.getReader();
  const decoder = new TextDecoder();

  console.log("Agent running...");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n").filter(l => l.startsWith("data:"));

    for (const line of lines) {
      try {
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === "agent.text_delta") {
          process.stdout.write(event.delta || "");
          fullText += event.delta || "";
        }
        if (event.type === "agent.done") {
          console.log("\n\nAgent session complete.");
        }
      } catch {}
    }
  }

  return { sessionId: session.id, summary: fullText };
}

// ─── Email summary ───────────────────────────────────────────────────────────

async function sendEmailSummary(summary, data) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body{font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a;background:#fff}
h1{font-size:20px;font-weight:600;margin-bottom:4px}
.date{font-size:13px;color:#888;margin-bottom:24px;font-family:monospace}
.stats{display:flex;gap:16px;margin-bottom:24px}
.stat{background:#f5f5f5;border-radius:8px;padding:12px 16px;flex:1}
.stat-val{font-size:24px;font-weight:600}
.stat-lbl{font-size:11px;color:#888;margin-top:2px}
.summary{background:#f9f9f9;border-radius:8px;padding:16px;white-space:pre-wrap;font-size:14px;line-height:1.7;border-left:3px solid #1a1a1a}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#e1f5ee;color:#085041;margin-right:4px;margin-bottom:4px}
.footer{margin-top:24px;font-size:11px;color:#aaa;text-align:center}
</style></head>
<body>
<h1>Brandon's Board — Daily Memory Sync</h1>
<div class="date">${today}</div>
<div class="stats">
  <div class="stat"><div class="stat-val">${data.tasks.length}</div><div class="stat-lbl">tasks completed</div></div>
  <div class="stat"><div class="stat-val">${data.dumps.length}</div><div class="stat-lbl">brain dumps</div></div>
  <div class="stat"><div class="stat-val">${data.clients.filter(c => c.status !== "clo").length}</div><div class="stat-lbl">active clients</div></div>
</div>
<div class="summary">${summary.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
<div class="footer">Memory updated automatically · Brandon's Board · Rollinshotz OS</div>
</body></html>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "Brandon's Board <onboarding@resend.dev>",
      to: [RECIPIENT_EMAIL],
      subject: `Brandon's Board — Daily Sync · ${today}`,
      html
    })
  });

  console.log(`Email sent to ${RECIPIENT_EMAIL}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Brandon's Board Nightly Sync ===");
  console.log(new Date().toLocaleString());
  console.log("");

  try {
    // 1. Fetch today's data from Supabase
    console.log("Fetching data from Supabase...");
    const data = await fetchTodayData();
    console.log(`Found: ${data.tasks?.length ?? "ERR"} completed tasks, ${data.dumps?.length ?? "ERR"} brain dumps, ${data.clients?.length ?? "ERR"} clients, ${data.finances?.length ?? "ERR"} finance rows`);

    // 2. Get or create memory store
    const storeId = await getOrCreateMemoryStore();

    // 3. Seed store with initial data (no-ops if already exists)
    await seedMemoryStore(storeId, data);

    // 4. Get or create agent
    const agentId = await getOrCreateAgent();

    // 5. Run agent session — reads Supabase context, writes memory
    const { summary } = await runAgentSession(agentId, storeId, data);

    // 6. Send email digest
    await sendEmailSummary(summary, data);

    console.log("\n=== Sync complete ===");
  } catch (err) {
    console.error("Error during sync:", err);
    process.exit(1);
  }
}

main();
