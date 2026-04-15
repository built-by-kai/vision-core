// ─── setup_project.js ──────────────────────────────────────────────────────
// POST /api/setup_project   { "page_id": "<project_page_id>" }
// Called by deposit_paid.js after deposit is confirmed.
//
// What it does:
//   1. Reads the Project page → gets Package (OS type), linked Deal (Add-ons)
//   2. Optionally reads Client Intake for delivery steps, timeline, etc.
//   3. Creates/reuses 5 phases matching create_invoice's PHASES_FULL
//   4. Creates OS-aware tasks per phase + add-on tasks in Phase 3
//   5. Links: Task → Phase, Task → Project, Phase → Project
//   6. Sets target date on Project based on Typical Project Length from intake
//
// Task generation is driven by OS type:
//   - Phase 1 (Discovery & Setup): generic for all OS types
//   - Phase 2 (Core Build): OS-specific module build tasks
//   - Phase 3 (Advanced Build & Expansion): add-on tasks + advanced config
//   - Phase 4 (Client Review & Revisions): generic review cycle
//   - Phase 5 (QA & Handover): generic handover tasks

import { getPage, patchPage, createPage, queryDB, plain, DB } from "../../lib/notion"

// ─── OS MODULE MAP ──────────────────────────────────────────────────────────
// Mirrors OS_DEFAULT_MODULES from proposal_template.js.
// Each OS type → { osGroup: [module names] }
const OS_MODULES = {
  'Revenue OS':    { 'Revenue OS':    ['CRM & Pipeline', 'Proposal & Deal Tracker', 'Payment Tracker', 'Finance & Expense Tracker', 'Product & Pricing Catalogue'] },
  'Operations OS': { 'Operations OS': ['Project Tracker', 'Task Management', 'Client Onboarding Tracker', 'Team Responsibility Matrix', 'SOP & Process Library'] },
  'Business OS':   { 'Revenue OS':    ['CRM & Pipeline', 'Proposal & Deal Tracker', 'Payment Tracker', 'Finance & Expense Tracker', 'Product & Pricing Catalogue'],
                     'Operations OS': ['Project Tracker', 'Task Management', 'Client Onboarding Tracker', 'Team Responsibility Matrix', 'SOP & Process Library'] },
  'Agency OS':     { 'Revenue OS':    ['CRM & Pipeline', 'Proposal & Deal Tracker', 'Payment Tracker', 'Finance & Expense Tracker', 'Product & Pricing Catalogue'],
                     'Operations OS': ['Project Tracker', 'Task Management', 'Client Onboarding Tracker', 'Team Responsibility Matrix', 'SOP & Process Library'],
                     'Marketing OS':  ['Campaign Tracker', 'Content Production Tracker', 'Content Calendar', 'Brand & Asset Library', 'Ads Tracker'] },
  'Marketing OS':  { 'Marketing OS':  ['Campaign Tracker', 'Content Production Tracker', 'Content Calendar', 'Brand & Asset Library', 'Ads Tracker'] },
  'Team OS':       { 'Team OS':       ['Hiring Pipeline', 'Team Onboarding Tracker', 'Performance & Goals', 'Leave & Availability', 'Role & Compensation Log'] },
  'Retention OS':  { 'Retention OS':  ['Client Health Tracker', 'NPS & Feedback Log', 'Renewal Pipeline', 'Upsell Opportunity Tracker', 'Support & Issue Log'] },
}

// ─── ADD-ON TASK MAP ────────────────────────────────────────────────────────
// Each add-on → array of tasks to create in Phase 3 (Advanced Build & Expansion)
const ADDON_TASKS = {
  'Marketing OS':               [
    { name: "Build Campaign Tracker",            priority: "High" },
    { name: "Build Content Production Tracker",  priority: "High" },
    { name: "Build Content Calendar",            priority: "High" },
    { name: "Build Brand & Asset Library",       priority: "Medium" },
    { name: "Build Ads Tracker",                 priority: "Medium" },
  ],
  'Team OS':                    [
    { name: "Build Hiring Pipeline",             priority: "High" },
    { name: "Build Team Onboarding Tracker",     priority: "High" },
    { name: "Build Performance & Goals",         priority: "Medium" },
    { name: "Build Leave & Availability",        priority: "Medium" },
    { name: "Build Role & Compensation Log",     priority: "Low" },
  ],
  'Retention OS':               [
    { name: "Build Client Health Tracker",       priority: "High" },
    { name: "Build NPS & Feedback Log",          priority: "High" },
    { name: "Build Renewal Pipeline",            priority: "High" },
    { name: "Build Upsell Opportunity Tracker",  priority: "Medium" },
    { name: "Build Support & Issue Log",         priority: "Medium" },
  ],
  'Enhanced Dashboard':         [
    { name: "Design dashboard layout & KPIs",    priority: "High" },
    { name: "Build chart widgets & embeds",      priority: "High" },
    { name: "Connect dashboard to OS data",      priority: "High" },
  ],
  'Project Kickoff Automation': [
    { name: "Build project kickoff automation (Make/N8N)", priority: "High" },
    { name: "Test automation trigger & task creation",     priority: "High" },
  ],
  'Campaign Kickoff Automation': [
    { name: "Build campaign kickoff automation (Make/N8N)", priority: "High" },
    { name: "Test automation trigger & task creation",      priority: "High" },
  ],
  'Client Onboarding Kickoff':  [
    { name: "Build client onboarding automation (Make/N8N)", priority: "High" },
    { name: "Test onboarding automation flow",               priority: "High" },
  ],
  'Renewal Kickoff Automation': [
    { name: "Build renewal check automation (Make/N8N)",  priority: "High" },
    { name: "Test renewal reminder trigger",              priority: "High" },
  ],
  'Hiring Kickoff Automation':  [
    { name: "Build hiring kickoff automation (Make/N8N)", priority: "High" },
    { name: "Test hiring automation flow",                priority: "High" },
  ],
  'Document Generation':        [
    { name: "Set up document generation endpoint",     priority: "High" },
    { name: "Build PDF template & Notion button",      priority: "High" },
    { name: "Test document generation end-to-end",     priority: "High" },
  ],
  'Lead Capture System':        [
    { name: "Set up lead capture form/WhatsApp integration", priority: "High" },
    { name: "Build auto-populate CRM automation",            priority: "High" },
    { name: "Test lead capture → CRM pipeline flow",         priority: "High" },
  ],
  'Ads Platform Integration':   [
    { name: "Connect ads platform API (Meta/Google/TikTok)", priority: "High" },
    { name: "Build data sync to Ads Tracker",                priority: "High" },
    { name: "Test real-time spend & performance pull",       priority: "High" },
  ],
  'Client Portal View':         [
    { name: "Build client-facing read-only Notion view",  priority: "Medium" },
    { name: "Configure portal permissions & sharing",     priority: "Medium" },
  ],
}

// ─── PHASE 1 — DISCOVERY & SETUP (generic) ─────────────────────────────────
const PHASE_1_TASKS = [
  { name: "Kick-off call & gather requirements",   priority: "High"   },
  { name: "Audit current workflows & tools",        priority: "High"   },
  { name: "Set up Notion workspace structure",      priority: "High"   },
  { name: "Install Base OS databases",              priority: "High"   },
  { name: "Configure permissions & sharing",        priority: "Medium" },
  { name: "Import existing data & contacts",        priority: "Medium" },
  { name: "Client review — Discovery sign-off",     priority: "High"   },
]

// ─── PHASE 2 — CORE BUILD (OS-specific) ────────────────────────────────────
// Generates tasks from OS_MODULES: one "Build <module>" task per module,
// plus standard Phase 2 tasks that apply to all OS types.
function buildPhase2Tasks(osType) {
  const tasks = []
  const groups = OS_MODULES[osType] || {}

  for (const [osGroup, modules] of Object.entries(groups)) {
    // Group header task (acts as a milestone)
    if (Object.keys(groups).length > 1) {
      tasks.push({ name: `── ${osGroup} Modules ──`, priority: "High", area: osGroup })
    }
    for (const mod of modules) {
      tasks.push({ name: `Build ${mod}`, priority: "High", area: osGroup })
    }
  }

  // If no OS matched (Starter OS, Micro Install, etc.), use generic tasks
  if (!tasks.length) {
    tasks.push(
      { name: "Build core database architecture",     priority: "High"   },
      { name: "Build primary module",                 priority: "High"   },
      { name: "Build secondary module",               priority: "High"   },
      { name: "Configure module relations",           priority: "High"   },
    )
  }

  // Standard Phase 2 tasks (all OS types)
  tasks.push(
    { name: "Set up database relations & rollups",     priority: "High"   },
    { name: "Build automations & recurring workflows", priority: "High"   },
    { name: "Build views, filters & sorts",            priority: "Medium" },
  )

  return tasks
}

// ─── PHASE 3 — ADVANCED BUILD & EXPANSION ──────────────────────────────────
// Standard advanced tasks + add-on tasks from ADDON_TASKS
function buildPhase3Tasks(osType, addons = []) {
  const tasks = [
    { name: "Build dashboard hub & reporting views",   priority: "High"   },
    { name: "Configure advanced automations",          priority: "High"   },
    { name: "Build template pages & quick-add buttons", priority: "Medium" },
  ]

  // Add-on specific tasks
  for (const addon of addons) {
    const addonTasks = ADDON_TASKS[addon]
    if (addonTasks) {
      tasks.push({ name: `── Add-on: ${addon} ──`, priority: "High" })
      tasks.push(...addonTasks)
    } else {
      // Unknown add-on — create a generic build task
      tasks.push({ name: `Build add-on: ${addon}`, priority: "High" })
    }
  }

  // If no add-ons, still add integration tasks
  if (!addons.length) {
    tasks.push(
      { name: "Review for integration opportunities", priority: "Medium" },
    )
  }

  return tasks
}

// ─── PHASE 4 — CLIENT REVIEW & REVISIONS (generic) ─────────────────────────
const PHASE_4_TASKS = [
  { name: "Client walkthrough & demo session",     priority: "High"   },
  { name: "Collect client feedback & change list",  priority: "High"   },
  { name: "Apply revisions — Round 1",             priority: "High"   },
  { name: "Apply revisions — Round 2 (if needed)", priority: "Medium" },
  { name: "Client sign-off on build",              priority: "High"   },
]

// ─── PHASE 5 — QA & HANDOVER (generic) ─────────────────────────────────────
const PHASE_5_TASKS = [
  { name: "Internal QA & testing",                priority: "High"   },
  { name: "Data validation & integrity check",    priority: "High"   },
  { name: "Training session with client team",    priority: "High"   },
  { name: "Prepare handover documentation",       priority: "High"   },
  { name: "Final handover & access transfer",     priority: "High"   },
  { name: "Post-launch check-in (1 week)",        priority: "Medium" },
]

// ─── 5 PHASE STRUCTURE ──────────────────────────────────────────────────────
// Matches PHASES_FULL in create_invoice.js exactly.
const PHASES = [
  { no: 1, name: "Phase 1 — Discovery & Setup" },
  { no: 2, name: "Phase 2 — Core Build" },
  { no: 3, name: "Phase 3 — Advanced Build & Expansion" },
  { no: 4, name: "Phase 4 — Client Review & Revisions" },
  { no: 5, name: "Phase 5 — QA & Handover" },
]

// ─── TARGET DATE helpers ─────────────────────────────────────────────────────
const LENGTH_DAYS = {
  "Under 2 weeks": 14,
  "2–4 weeks":     28,
  "1–3 months":    75,
  "3+ months":     105,
}

function addDays(isoDate, days) {
  const d = new Date(isoDate)
  d.setDate(d.getDate() + days)
  return d.toISOString().split("T")[0]
}

// Phase date splits: Discovery 10%, Core Build 35%, Advanced 25%, Review 15%, Handover 15%
const PHASE_SPLITS = [0, 0.10, 0.45, 0.70, 0.85, 1.0]

function phaseEndDate(startDate, phaseNo, totalDays) {
  const start = addDays(startDate, Math.round(totalDays * PHASE_SPLITS[phaseNo - 1]))
  const end   = addDays(startDate, Math.round(totalDays * PHASE_SPLITS[phaseNo]))
  return { start, end }
}

// ─── READ ADD-ONS FROM DEAL ─────────────────────────────────────────────────
async function readDealAddons(projectPage, token) {
  try {
    const dealIds = (projectPage.properties.Deals?.relation || []).map(r => r.id.replace(/-/g, ""))
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

// ─── READ CLIENT INTAKE ───────────────────────────────────────────────────────
async function readClientIntake(projectPage, token) {
  try {
    const dealIds = (projectPage.properties.Deals?.relation || []).map(r => r.id.replace(/-/g, ""))
    for (const dealId of dealIds) {
      const deal = await getPage(dealId, token)
      const implIds = (deal.properties.Implementation?.relation || []).map(r => r.id.replace(/-/g, ""))
      if (implIds.length) {
        const intake = await getPage(implIds[0], token)
        return intake.properties
      }
    }
  } catch (e) {
    console.warn("[setup_project] readClientIntake:", e.message)
  }
  return null
}

// ─── EXTRACT CUSTOM TASKS FROM INTAKE ────────────────────────────────────────
function extractCustomTasks(intakeProps) {
  const customTasks = []

  const deliveryProcess = plain(intakeProps["Delivery Process"]?.rich_text || [])
  if (deliveryProcess) {
    for (const line of deliveryProcess.split("\n").filter(l => l.trim())) {
      const cleaned = line.replace(/^\d+\.\s*/, "").trim()
      if (cleaned.length > 3) customTasks.push({ name: cleaned, priority: "High" })
    }
  }

  const onboardingProcess = plain(intakeProps["Onboarding Process"]?.rich_text || [])
  if (onboardingProcess) {
    for (const line of onboardingProcess.split("\n").filter(l => l.trim())) {
      const cleaned = line.replace(/^\d+\.\s*/, "").trim()
      if (cleaned.length > 3) customTasks.push({ name: `Onboarding: ${cleaned}`, priority: "Medium" })
    }
  }

  const prioritySOPs = plain(intakeProps["Priority SOPs"]?.rich_text || [])
  if (prioritySOPs) {
    for (const sop of prioritySOPs.split(",").map(s => s.trim()).filter(Boolean)) {
      customTasks.push({ name: `Build SOP: ${sop}`, priority: "High" })
    }
  }

  return customTasks
}

// ─── MAIN SETUP ──────────────────────────────────────────────────────────────
async function setup(payload) {
  const token   = process.env.NOTION_API_KEY
  const rawId   = payload.page_id || payload.source?.page_id || payload.data?.page_id
  if (!rawId) throw new Error("No page_id in payload")
  const projectId = rawId.replace(/-/g, "")

  const project     = await getPage(projectId, token)
  const projectProps = project.properties

  // Guard: don't recreate if tasks already exist for this project
  const existingTasks = projectProps.Tasks?.relation || []
  if (existingTasks.length > 0) {
    console.log(`[setup_project] tasks already exist for ${projectId} — skipping`)
    return { status: "skipped", reason: "tasks already exist", project_id: projectId }
  }

  // ── Read OS type from Project.Package ──
  const osType = projectProps.Package?.select?.name || ""
  console.log(`[setup_project] OS type: "${osType}"`)

  // ── Read add-ons from linked Deal ──
  const addons = await readDealAddons(project, token)
  console.log(`[setup_project] Add-ons: ${addons.length ? addons.join(", ") : "(none)"}`)

  // ── Check for existing phases (created by create_invoice.js) ──
  const existingPhaseRels = projectProps.Phases?.relation || []
  let existingPhaseMap = {}  // phase_no → phaseId
  if (existingPhaseRels.length > 0) {
    for (const rel of existingPhaseRels) {
      try {
        const ph = await getPage(rel.id.replace(/-/g, ""), token)
        const phNo = ph.properties["Phase No."]?.number
        if (phNo) existingPhaseMap[phNo] = rel.id.replace(/-/g, "")
      } catch {}
    }
    console.log(`[setup_project] found ${Object.keys(existingPhaseMap).length} existing phases — will add tasks`)
  }

  const today     = new Date().toISOString().split("T")[0]
  const startDate = projectProps["Start Date"]?.date?.start || today

  // ── Read client intake for customisation ──
  const intakeProps = await readClientIntake(project, token)
  const typicalLength = intakeProps
    ? plain(intakeProps["Typical Project Length"] === undefined
        ? []
        : [{ plain_text: (intakeProps["Typical Project Length"]?.select?.name || "") }])
    : ""
  const totalDays = LENGTH_DAYS[typicalLength] || LENGTH_DAYS["2–4 weeks"]
  const projectTargetDate = addDays(startDate, totalDays)

  // Extract custom tasks from intake (appended to Phase 2)
  const customPh2Tasks = intakeProps ? extractCustomTasks(intakeProps) : []

  // Services list → store in project Notes if not already set
  const servicesList = intakeProps ? plain(intakeProps["Services List"]?.rich_text || []) : ""

  // ── Update project with target date + notes ──
  const projectUpdates = {
    "Targeted Completion": { date: { start: projectTargetDate } },
  }
  if (servicesList) {
    const existingNotes = plain(projectProps.Notes?.rich_text || [])
    if (!existingNotes) {
      projectUpdates["Notes"] = { rich_text: [{ type: "text", text: { content: `Services: ${servicesList}` } }] }
    }
  }
  await patchPage(projectId, projectUpdates, token)

  // ── Build task lists per phase ──
  const phase2Tasks = [...buildPhase2Tasks(osType), ...customPh2Tasks]
  const phase3Tasks = buildPhase3Tasks(osType, addons)

  const phaseTaskMap = {
    1: PHASE_1_TASKS,
    2: phase2Tasks,
    3: phase3Tasks,
    4: PHASE_4_TASKS,
    5: PHASE_5_TASKS,
  }

  // ── Create phases (or reuse existing) + tasks ──
  const phasesCreated = []
  const tasksCreated  = []

  for (const phase of PHASES) {
    const { start: phStart, end: phEnd } = phaseEndDate(startDate, phase.no, totalDays)
    let phaseId = existingPhaseMap[phase.no] || null

    if (!phaseId) {
      // Phase doesn't exist yet — create it
      const phaseBody = {
        parent: { database_id: DB.PHASES },
        properties: {
          "Phase Name": { title: [{ type: "text", text: { content: phase.name } }] },
          "Phase No.":  { number: phase.no },
          "Status":     { select: { name: "Not Started" } },
          "Start Date": { date: { start: phStart } },
          "Due Date":   { date: { start: phEnd } },
          "Project":    { relation: [{ id: projectId }] },
        },
      }
      const created = await createPage(phaseBody, token)
      phaseId = created.id.replace(/-/g, "")
      console.log(`[setup_project] Created ${phase.name} → ${phaseId}`)
    } else {
      // Phase exists (from create_invoice) — update dates
      await patchPage(phaseId, {
        "Start Date": { date: { start: phStart } },
        "Due Date":   { date: { start: phEnd } },
      }, token).catch(() => {})
      console.log(`[setup_project] Reusing ${phase.name} → ${phaseId} (adding tasks)`)
    }
    phasesCreated.push(phaseId)

    // Create tasks for this phase
    const taskList = phaseTaskMap[phase.no] || []
    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i]

      // Skip separator tasks (── markers) — they're just visual grouping
      if (task.name.startsWith("──")) continue

      const taskProps = {
        "Task Name":    { title: [{ type: "text", text: { content: task.name } }] },
        "Status":       { status: { name: "Not Started" } },
        "Priority":     { select: { name: task.priority || "Medium" } },
        "Phase Stage":  { select: { name: `Phase ${phase.no}` } },
        "Phase":        { relation: [{ id: phaseId }] },
        "Project":      { relation: [{ id: projectId }] },
        "Task No.":     { number: i + 1 },
      }

      // Set Area if available (OS group name for Phase 2 tasks)
      if (task.area) {
        try {
          taskProps["Area"] = { select: { name: task.area } }
        } catch {}
      }

      const taskBody = {
        parent: { database_id: DB.TASKS },
        properties: taskProps,
      }
      const taskPage = await createPage(taskBody, token)
      tasksCreated.push(taskPage.id.replace(/-/g, ""))
    }
  }

  // Link all phases back to the project
  await patchPage(projectId, {
    "Phases": { relation: phasesCreated.map(id => ({ id })) },
  }, token)

  // Set Phase 1 to In Progress (build has started)
  if (phasesCreated[0]) {
    await patchPage(phasesCreated[0], {
      "Status": { select: { name: "In Progress" } },
    }, token)
  }

  const summary = {
    status:         "success",
    project_id:     projectId,
    os_type:        osType || "(generic)",
    addons:         addons,
    phases_created: phasesCreated.length,
    tasks_created:  tasksCreated.length,
    target_date:    projectTargetDate,
    custom_tasks:   customPh2Tasks.length,
    task_breakdown: {
      phase_1: PHASE_1_TASKS.length,
      phase_2: phase2Tasks.filter(t => !t.name.startsWith("──")).length,
      phase_3: phase3Tasks.filter(t => !t.name.startsWith("──")).length,
      phase_4: PHASE_4_TASKS.length,
      phase_5: PHASE_5_TASKS.length,
    },
  }

  console.log(`[setup_project] Done: ${phasesCreated.length} phases, ${tasksCreated.length} tasks for ${osType || "generic"} project ${projectId}`)
  return summary
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Setup Project", status: "ready" })
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
