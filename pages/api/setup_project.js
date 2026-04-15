// ─── setup_project.js ──────────────────────────────────────────────────────
// POST /api/setup_project   { "page_id": "<project_page_id>" }
// Called by deposit_paid.js after deposit is confirmed.
//
// What it does (template-driven):
//   1. Reads Project → Package (OS type)
//   2. Queries Phase Templates DB for phase definitions matching this OS type
//   3. Queries Phase Template Tasks DB for task definitions (OS-specific + common)
//   4. For composite OS types (Business OS, Agency OS), resolves Source OS references
//      e.g. Business OS Phase 2 pulls tasks from Operations OS Phases 2,3
//   5. Creates phases as parent items in Phase Tasks DB (DB.PHASES)
//   6. Creates tasks as sub-items in Phase Tasks DB using Parent item relation
//   7. Links phases to Project, sets current phase
//
// Sub-item architecture:
//   Phase Tasks DB has a self-relation (Parent item ↔ Sub-item).
//   Phases are top-level entries; tasks nest under them as sub-items.
//   This gives native Notion collapsing/grouping in the Phase Tasks view.

import { getPage, patchPage, createPage, queryDB, plain, DB } from "../../lib/notion"

// ─── Addon slug ↔ Deal add-on name mapping ──────────────────────────────────
const ADDON_SLUGS = {
  "addon-ai-agent":              "AI Agent Integration",
  "addon-lead-capture":          "Lead Capture System",
  "addon-widget":                "Custom Widget",
  "addon-workflow-integration":  "Automation & Workflow Integration",
  "addon-automation-within":     "Automation (within database)",
  "addon-automation-cross":      "Automation (cross-database)",
  "addon-client-portal":         "Client Portal View",
  "addon-api-integration":       "API / External Integration",
  "addon-system-module":         "Additional System Module",
}
// Reverse: addon display name → slug
const ADDON_NAMES = Object.fromEntries(
  Object.entries(ADDON_SLUGS).map(([slug, name]) => [name, slug])
)

// ─── Date helpers ────────────────────────────────────────────────────────────
const LENGTH_DAYS = {
  "Under 2 weeks": 14,
  "2–4 weeks":     28,
  "1–3 months":    75,
  "3+ months":     105,
}

function addDays(iso, days) {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString().split("T")[0]
}

// ─── Extract task info from a Phase Template Tasks page ─────────────────────
function extractTask(page) {
  const p = page.properties
  return {
    name:         plain(p["Task Name"]?.title || []),
    order:        p["Task Order"]?.number || 0,
    priority:     p["Priority"]?.select?.name || "Medium",
    phaseNo:      p["Phase No."]?.number ?? null,
    slug:         plain(p["Product Slug"]?.rich_text || []),
    deliverables: plain(p["Deliverables"]?.rich_text || []),
  }
}

// ─── Parse "2,3" → [2, 3] from Source Phase Nos. ───────────────────────────
function parseSourcePhaseNos(templatePage) {
  const text = plain(templatePage.properties["Source Phase Nos."]?.rich_text || [])
  if (!text) return []
  return text.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n))
}

// ─── Read add-ons from Deal ─────────────────────────────────────────────────
async function readDealAddons(project, token) {
  try {
    const dealIds = (project.properties.Deals?.relation || []).map(r => r.id.replace(/-/g, ""))
    for (const dealId of dealIds) {
      const deal = await getPage(dealId, token)
      const addons = (deal.properties["Add-ons"]?.multi_select || []).map(a => a.name)
      if (addons.length) return addons
    }
  } catch (e) {
    console.warn("[setup_project] readDealAddons:", e.message)
  }
  return []
}

// ─── Read existing phases for project → { map: {phaseNo: pageId}, hasSubItems } ─
async function readExistingPhases(project, token) {
  const map = {}
  let hasSubItems = false
  const rels = project.properties.Phases?.relation || []
  if (!rels.length) return { map, hasSubItems }

  const reads = rels.map(async (rel) => {
    try {
      const ph = await getPage(rel.id.replace(/-/g, ""), token)
      const no = ph.properties["Phase No."]?.number
      if (no != null) map[no] = rel.id.replace(/-/g, "")
      const subs = ph.properties["Sub-item"]?.relation || []
      if (subs.length) hasSubItems = true
    } catch {}
  })
  await Promise.all(reads)
  return { map, hasSubItems }
}

// ─── Read Client Intake for timeline info ────────────────────────────────────
async function readIntakeTimeline(project, token) {
  try {
    const dealIds = (project.properties.Deals?.relation || []).map(r => r.id.replace(/-/g, ""))
    for (const dealId of dealIds) {
      const deal = await getPage(dealId, token)
      const implIds = (deal.properties.Implementation?.relation || []).map(r => r.id.replace(/-/g, ""))
      if (implIds.length) {
        const intake = await getPage(implIds[0], token)
        return intake.properties["Typical Project Length"]?.select?.name || ""
      }
    }
  } catch {}
  return ""
}

// ─── MAIN SETUP ──────────────────────────────────────────────────────────────
async function setup(payload) {
  const token = process.env.NOTION_API_KEY
  const rawId = payload.page_id || payload.source?.page_id || payload.data?.page_id
  if (!rawId) throw new Error("No page_id in payload")
  const projectId = rawId.replace(/-/g, "")

  const project = await getPage(projectId, token)
  const osType  = project.properties.Package?.select?.name || ""
  console.log(`[setup_project] OS type: "${osType}"`)

  const today     = new Date().toISOString().split("T")[0]
  const startDate = project.properties["Start Date"]?.date?.start || today

  // ── Parallel reads: templates, tasks, existing phases, addons, timeline ──
  const [phaseTemplates, osTasks, commonTasks, phaseInfo, addons, timelineLabel] = await Promise.all([
    // Phase definitions for this OS type
    osType
      ? queryDB(DB.PHASE_TEMPLATES, { property: "OS Type", select: { equals: osType } }, token)
      : Promise.resolve([]),
    // OS-specific template tasks
    osType
      ? queryDB(DB.PHASE_TEMPLATE_TASKS, { property: "OS Type", select: { equals: osType } }, token)
      : Promise.resolve([]),
    // Common template tasks (OS Type empty — shared across all OS types)
    queryDB(DB.PHASE_TEMPLATE_TASKS, { property: "OS Type", select: { is_empty: true } }, token),
    // Existing phases from create_invoice
    readExistingPhases(project, token),
    // Deal add-ons
    readDealAddons(project, token),
    // Client intake timeline
    readIntakeTimeline(project, token),
  ])

  const { map: existingPhaseMap, hasSubItems } = phaseInfo

  // Guard: don't recreate if sub-item tasks already exist
  if (hasSubItems) {
    console.log(`[setup_project] sub-items already exist — skipping`)
    return { status: "skipped", reason: "tasks already exist", project_id: projectId }
  }

  console.log(`[setup_project] Templates: ${phaseTemplates.length} phases, ${osTasks.length} OS tasks, ${commonTasks.length} common tasks`)
  console.log(`[setup_project] Existing phases: ${Object.keys(existingPhaseMap).length}, Add-ons: ${addons.length ? addons.join(", ") : "(none)"}`)

  // ── Resolve Source OS tasks for composite phases (e.g. Business OS) ──────
  // Phase Templates with Source OS reference another OS type's tasks.
  // Business OS Phase 2 → Source OS: Operations OS, Source Phase Nos: "2,3"
  // Business OS Phase 3 → Source OS: Revenue OS, Source Phase Nos: "2,3"
  const sourceOSNames = new Set()
  const sourcePhaseConfig = [] // { targetPhaseNo, sourceOS, sourcePhaseNos }

  for (const pt of phaseTemplates) {
    const srcOS  = pt.properties["Source OS"]?.select?.name
    const srcNos = parseSourcePhaseNos(pt)
    if (srcOS && srcNos.length) {
      sourceOSNames.add(srcOS)
      sourcePhaseConfig.push({
        targetPhaseNo: pt.properties["Phase No."]?.number,
        sourceOS:      srcOS,
        sourcePhaseNos: srcNos,
      })
    }
  }

  // Fetch source OS tasks in parallel
  const sourceTasksByOS = {}
  if (sourceOSNames.size) {
    const queries = [...sourceOSNames].map(async (srcOS) => {
      const tasks = await queryDB(DB.PHASE_TEMPLATE_TASKS, {
        property: "OS Type", select: { equals: srcOS }
      }, token)
      sourceTasksByOS[srcOS] = tasks
    })
    await Promise.all(queries)
    console.log(`[setup_project] Source OS tasks fetched: ${[...sourceOSNames].map(os => `${os}(${sourceTasksByOS[os]?.length || 0})`).join(", ")}`)
  }

  // ── Build task map: phaseNo → [task objects] ──────────────────────────────
  const taskMap = {}

  function addTask(phaseNo, task) {
    if (phaseNo == null) return
    if (!taskMap[phaseNo]) taskMap[phaseNo] = []
    // Deduplicate by task name within the same phase
    if (taskMap[phaseNo].some(t => t.name === task.name)) return
    taskMap[phaseNo].push(task)
  }

  // 1. Common tasks (OS Type empty, no Product Slug = shared across all OS)
  for (const page of commonTasks) {
    const task = extractTask(page)
    if (task.slug) continue  // addon-specific — handle in step 4
    if (task.phaseNo == null) continue
    addTask(task.phaseNo, task)
  }

  // 2. OS-specific tasks
  for (const page of osTasks) {
    const task = extractTask(page)
    if (task.phaseNo == null) continue
    addTask(task.phaseNo, task)
  }

  // 3. Source OS tasks (remapped to target phase)
  // Only includes OS-specific tasks from the source — common tasks are already
  // handled in step 1 by their own phase number. Adding common tasks here too
  // would duplicate them across multiple target phases.
  for (const cfg of sourcePhaseConfig) {
    const srcTasks = sourceTasksByOS[cfg.sourceOS] || []
    for (const page of srcTasks) {
      const task = extractTask(page)
      if (cfg.sourcePhaseNos.includes(task.phaseNo)) {
        addTask(cfg.targetPhaseNo, task)
      }
    }
  }

  // 4. Addon tasks (Product Slug matches project's add-ons)
  if (addons.length) {
    // Build set of slugs from deal add-on names
    const addonSlugs = new Set()
    for (const addon of addons) {
      // Try exact name → slug mapping
      if (ADDON_NAMES[addon]) addonSlugs.add(ADDON_NAMES[addon])
      // Also try generating slug from name
      const generated = "addon-" + addon.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
      addonSlugs.add(generated)
    }

    // Find the last "build" phase number (before review/handover phases)
    const phaseNos = phaseTemplates
      .map(pt => pt.properties["Phase No."]?.number)
      .filter(n => n != null)
      .sort((a, b) => a - b)
    // Default addon phase = second-to-last build phase, or phase 2
    const addonPhaseNo = phaseNos.length >= 4 ? phaseNos[phaseNos.length - 3] : (phaseNos[1] || 2)

    for (const page of commonTasks) {
      const task = extractTask(page)
      if (!task.slug) continue
      if (!addonSlugs.has(task.slug)) continue
      // Use the task's phase number if set, otherwise assign to addon build phase
      addTask(task.phaseNo ?? addonPhaseNo, task)
    }
    console.log(`[setup_project] Addon slugs matched: ${[...addonSlugs].join(", ")}`)
  }

  // Sort tasks within each phase by Task Order
  for (const phaseNo of Object.keys(taskMap)) {
    taskMap[phaseNo].sort((a, b) => (a.order || 0) - (b.order || 0))
  }

  // ── Sort phase templates by Phase No. ─────────────────────────────────────
  phaseTemplates.sort((a, b) =>
    (a.properties["Phase No."]?.number || 0) - (b.properties["Phase No."]?.number || 0)
  )

  // Fallback: if no templates found for this OS type, create generic phases
  if (!phaseTemplates.length) {
    console.warn(`[setup_project] No templates for "${osType}" — using generic 3-phase fallback`)
    const fallback = [
      { no: 1, name: "Phase 1 — Setup",     del: "Workspace setup, scope confirmation" },
      { no: 2, name: "Phase 2 — Build",     del: "Core modules built and configured" },
      { no: 3, name: "Phase 3 — Handover",  del: "Client review, QA, handover" },
    ]
    for (const f of fallback) {
      phaseTemplates.push({
        properties: {
          "Phase Name":   { title: [{ text: { content: f.name } }] },
          "Phase No.":    { number: f.no },
          "Deliverables": { rich_text: [{ text: { content: f.del } }] },
          "Source OS":    { select: null },
        },
      })
    }
  }

  // ── Calculate timeline ────────────────────────────────────────────────────
  const totalDays   = LENGTH_DAYS[timelineLabel] || LENGTH_DAYS["2–4 weeks"]
  const totalPhases = phaseTemplates.length
  const targetDate  = addDays(startDate, totalDays)

  // ── Create / reuse phases (parallel) ──────────────────────────────────────
  const phasePromises = phaseTemplates.map(async (pt, idx) => {
    const phaseNo      = pt.properties["Phase No."]?.number
    const phaseName    = plain(pt.properties["Phase Name"]?.title || [])
    const deliverables = plain(pt.properties["Deliverables"]?.rich_text || [])

    // Proportional date split
    const phStart = addDays(startDate, Math.round(totalDays * (idx / totalPhases)))
    const phEnd   = addDays(startDate, Math.round(totalDays * ((idx + 1) / totalPhases)))

    let phaseId = existingPhaseMap[phaseNo] || null

    if (!phaseId) {
      // Create new phase
      const created = await createPage({
        parent: { database_id: DB.PHASES },
        properties: {
          "Phase Name":   { title: [{ text: { content: phaseName } }] },
          "Phase No.":    { number: phaseNo },
          "Status":       { select: { name: "Not Started" } },
          "Start Date":   { date: { start: phStart } },
          "Due Date":     { date: { start: phEnd } },
          "Project":      { relation: [{ id: projectId }] },
          ...(deliverables ? { "Deliverables": { rich_text: [{ text: { content: deliverables } }] } } : {}),
        },
      }, token)
      phaseId = created.id.replace(/-/g, "")
      console.log(`[setup_project] Created ${phaseName} → ${phaseId}`)
    } else {
      // Reuse existing — update name, dates, deliverables to match template
      await patchPage(phaseId, {
        "Phase Name":   { title: [{ text: { content: phaseName } }] },
        "Start Date":   { date: { start: phStart } },
        "Due Date":     { date: { start: phEnd } },
        ...(deliverables ? { "Deliverables": { rich_text: [{ text: { content: deliverables } }] } } : {}),
      }, token).catch(() => {})
      console.log(`[setup_project] Reusing ${phaseName} → ${phaseId}`)
    }

    return { no: phaseNo, id: phaseId, name: phaseName }
  })

  const resolvedPhases = await Promise.all(phasePromises)
  resolvedPhases.sort((a, b) => a.no - b.no)

  // ── Build sub-item task bodies ────────────────────────────────────────────
  const allTaskBodies = []
  const taskBreakdown = {}

  for (const phase of resolvedPhases) {
    const tasks = taskMap[phase.no] || []
    taskBreakdown[`phase_${phase.no}`] = tasks.length

    for (const task of tasks) {
      const props = {
        "Phase Name":   { title: [{ text: { content: task.name } }] },
        "Status":       { select: { name: "Not Started" } },
        "Phase No.":    { number: phase.no },
        "Project":      { relation: [{ id: projectId }] },
        "Parent item":  { relation: [{ id: phase.id }] },
      }
      // Store deliverables / priority info in Notes if present
      const noteParts = []
      if (task.priority && task.priority !== "Medium") noteParts.push(`Priority: ${task.priority}`)
      if (task.deliverables) noteParts.push(task.deliverables)
      if (noteParts.length) {
        props["Notes"] = { rich_text: [{ text: { content: noteParts.join(" · ") } }] }
      }

      allTaskBodies.push({ parent: { database_id: DB.PHASES }, properties: props })
    }
  }

  // ── Create tasks in parallel batches of 8 ─────────────────────────────────
  const BATCH = 8
  const tasksCreated = []
  for (let i = 0; i < allTaskBodies.length; i += BATCH) {
    const batch = allTaskBodies.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(body => createPage(body, token).then(p => p.id.replace(/-/g, "")))
    )
    tasksCreated.push(...results)
  }

  // ── Link phases to project + set current phase + target date ──────────────
  const phaseIds   = resolvedPhases.map(p => p.id)
  const firstPhase = resolvedPhases[0]

  await Promise.all([
    patchPage(projectId, {
      "Phases":               { relation: phaseIds.map(id => ({ id })) },
      "Phase":                { select: { name: firstPhase?.name || "Phase 0 — Pre-Build" } },
      "Targeted Completion":  { date: { start: targetDate } },
    }, token),
    // Set first phase to In Progress
    firstPhase
      ? patchPage(firstPhase.id, { "Status": { select: { name: "In Progress" } } }, token)
      : Promise.resolve(),
  ])

  const summary = {
    status:         "success",
    project_id:     projectId,
    os_type:        osType || "(generic)",
    addons,
    phases_created: phaseIds.length,
    tasks_created:  tasksCreated.length,
    target_date:    targetDate,
    task_breakdown: taskBreakdown,
  }

  console.log(`[setup_project] Done: ${phaseIds.length} phases, ${tasksCreated.length} sub-item tasks for ${osType || "generic"} project ${projectId}`)
  return summary
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Setup Project (template-driven)", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const result = await setup(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[setup_project]", e)
    return res.status(500).json({ error: e.message })
  }
}
