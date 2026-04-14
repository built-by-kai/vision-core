// ─── setup_project.js ──────────────────────────────────────────────────────
// POST /api/setup_project   { "page_id": "<project_page_id>" }
// Called by deposit_paid.js after deposit is confirmed.
//
// What it does:
//   1. Reads the Project page → gets Package, linked Deal, linked Client Intake
//   2. Reads the Client Intake (CLIENT_IMPL DB) to pull delivery steps, timeline, etc.
//   3. Creates Phase 1 (Discovery & Setup), Phase 2 (Core Build), Phase 3 (Launch & Handover)
//   4. Creates standard tasks per phase + custom tasks from intake form data
//   5. Links: Task → Phase, Task → Project, Phase → Project
//   6. Sets target date on Project based on Typical Project Length from intake
//
// Phase/Task structure is based on what's already in your Notion template set.

import { getPage, patchPage, createPage, queryDB, plain, DB } from "../../lib/notion"

// ─── PHASE TEMPLATES ────────────────────────────────────────────────────────
// Standard phases with default tasks per phase.
// Phase 2 gets augmented with custom tasks from the client intake form.

const PHASE_TEMPLATES = [
  {
    no:    1,
    name:  "Phase 1 — Discovery & Setup",
    tasks: [
      { name: "Kick-off call & gather requirements",  priority: "High"   },
      { name: "Audit current workflows & tools",       priority: "High"   },
      { name: "Set up Notion workspace structure",     priority: "High"   },
      { name: "Configure permissions & sharing",       priority: "Medium" },
      { name: "Import existing data & contacts",       priority: "Medium" },
      { name: "Client review — Discovery sign-off",    priority: "High"   },
    ],
  },
  {
    no:    2,
    name:  "Phase 2 — Core Build",
    tasks: [
      { name: "Build task & project management system", priority: "High"   },
      { name: "Build SOP & documentation hub",          priority: "High"   },
      { name: "Set up automations & recurring tasks",   priority: "High"   },
      { name: "Build dashboards & reporting views",     priority: "Medium" },
      { name: "Build meeting notes & agenda system",    priority: "Medium" },
    ],
    // Custom tasks from intake are appended here
  },
  {
    no:    3,
    name:  "Phase 3 — Launch & Handover",
    tasks: [
      { name: "Internal QA & testing",               priority: "High"   },
      { name: "Client walkthrough & training session", priority: "High"  },
      { name: "Collect feedback & adjustments",       priority: "High"   },
      { name: "Apply revisions",                      priority: "High"   },
      { name: "Final handover & documentation",       priority: "High"   },
      { name: "Post-launch check-in (1 week)",        priority: "Medium" },
    ],
  },
]

// ─── TARGET DATE helpers ─────────────────────────────────────────────────────
const LENGTH_DAYS = {
  "Under 2 weeks": 14,
  "2–4 weeks":     28,
  "1–3 months":    75,   // ~2.5 months default
  "3+ months":     105,  // ~3.5 months default
}

function addDays(isoDate, days) {
  const d = new Date(isoDate)
  d.setDate(d.getDate() + days)
  return d.toISOString().split("T")[0]
}

function phaseEndDate(startDate, phaseNo, totalDays) {
  // Rough split: Phase 1 = 20%, Phase 2 = 60%, Phase 3 = 20%
  const splits = [0, 0.2, 0.8, 1.0]
  const start = addDays(startDate, Math.round(totalDays * splits[phaseNo - 1]))
  const end   = addDays(startDate, Math.round(totalDays * splits[phaseNo]))
  return { start, end }
}

// ─── EXTRACT CUSTOM TASKS FROM INTAKE ────────────────────────────────────────
// Reads the CLIENT_IMPL page and pulls custom Phase 2 tasks from:
//   - Delivery Process (numbered steps the client described)
//   - Priority SOPs (SOPs to build)
// Returns array of { name, priority }
function extractCustomTasks(intakeProps) {
  const customTasks = []

  // Delivery Process: "1. Step one\n2. Step two\n..."
  const deliveryProcess = plain(intakeProps["Delivery Process"]?.rich_text || [])
  if (deliveryProcess) {
    const lines = deliveryProcess.split("\n").filter(l => l.trim())
    for (const line of lines) {
      const cleaned = line.replace(/^\d+\.\s*/, "").trim()
      if (cleaned.length > 3) {
        customTasks.push({ name: cleaned, priority: "High" })
      }
    }
  }

  // Onboarding Process: client's onboarding steps become Phase 2 tasks
  const onboardingProcess = plain(intakeProps["Onboarding Process"]?.rich_text || [])
  if (onboardingProcess) {
    const lines = onboardingProcess.split("\n").filter(l => l.trim())
    for (const line of lines) {
      const cleaned = line.replace(/^\d+\.\s*/, "").trim()
      if (cleaned.length > 3) {
        customTasks.push({ name: `Onboarding: ${cleaned}`, priority: "Medium" })
      }
    }
  }

  // Priority SOPs: each one becomes a specific build task
  const prioritySOPs = plain(intakeProps["Priority SOPs"]?.rich_text || [])
  if (prioritySOPs) {
    const sops = prioritySOPs.split(",").map(s => s.trim()).filter(Boolean)
    for (const sop of sops) {
      customTasks.push({ name: `Build SOP: ${sop}`, priority: "High" })
    }
  }

  return customTasks
}

// ─── READ CLIENT INTAKE ───────────────────────────────────────────────────────
// Looks for a linked CLIENT_IMPL page via the Deal → Implementation relation.
// Returns the intake page properties or null if not found.
async function readClientIntake(projectPage, token) {
  try {
    // Project → Deals → Implementation (CLIENT_IMPL)
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

// ─── MAIN SETUP ──────────────────────────────────────────────────────────────
async function setup(payload) {
  const token   = process.env.NOTION_API_KEY
  const rawId   = payload.page_id || payload.source?.page_id || payload.data?.page_id
  if (!rawId) throw new Error("No page_id in payload")
  const projectId = rawId.replace(/-/g, "")

  const project     = await getPage(projectId, token)
  const projectProps = project.properties

  // Guard: don't recreate if phases already exist
  const existingPhases = projectProps.Phases?.relation || []
  if (existingPhases.length > 0) {
    console.log(`[setup_project] phases already exist for ${projectId} — skipping`)
    return { status: "skipped", reason: "phases already exist", project_id: projectId }
  }

  const today    = new Date().toISOString().split("T")[0]
  const startDate = projectProps["Start Date"]?.date?.start || today

  // Read client intake for customisation
  const intakeProps = await readClientIntake(project, token)

  // Determine project length for target dates
  const typicalLength = intakeProps
    ? plain(intakeProps["Typical Project Length"] === undefined
        ? []
        : [{ plain_text: (intakeProps["Typical Project Length"]?.select?.name || "") }])
    : ""
  const totalDays = LENGTH_DAYS[typicalLength] || LENGTH_DAYS["2–4 weeks"]
  const projectTargetDate = addDays(startDate, totalDays)

  // Extract custom tasks from intake
  const customPh2Tasks = intakeProps ? extractCustomTasks(intakeProps) : []

  // Services list → store in project Notes if not already set
  const servicesList = intakeProps ? plain(intakeProps["Services List"]?.rich_text || []) : ""

  // Update project with target date + notes
  const projectUpdates = {
    "Target End Date": { date: { start: projectTargetDate } },
  }
  if (servicesList) {
    const existingNotes = plain(projectProps.Notes?.rich_text || [])
    if (!existingNotes) {
      projectUpdates["Notes"] = { rich_text: [{ type: "text", text: { content: `Services: ${servicesList}` } }] }
    }
  }
  await patchPage(projectId, projectUpdates, token)

  // Create phases + tasks
  const phasesCreated = []
  const tasksCreated  = []

  for (const template of PHASE_TEMPLATES) {
    const { start: phStart, end: phEnd } = phaseEndDate(startDate, template.no, totalDays)

    // Create Phase page
    const phaseBody = {
      parent: { database_id: DB.PHASES },
      properties: {
        "Phase Name": { title: [{ type: "text", text: { content: template.name } }] },
        "Phase No.":  { number: template.no },
        "Status":     { select: { name: "Not Started" } },
        "Start Date": { date: { start: phStart } },
        "Due Date":   { date: { start: phEnd } },
        "Project":    { relation: [{ id: projectId }] },
      },
    }
    const phase    = await createPage(phaseBody, token)
    const phaseId  = phase.id.replace(/-/g, "")
    phasesCreated.push(phaseId)
    console.log(`[setup_project] Created ${template.name} → ${phaseId}`)

    // Build task list: standard + custom (Phase 2 only)
    let taskList = [...template.tasks]
    if (template.no === 2 && customPh2Tasks.length > 0) {
      taskList = [...taskList, ...customPh2Tasks]
    }

    // Create tasks
    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i]
      const taskBody = {
        parent: { database_id: DB.TASKS },
        properties: {
          "Task Name":    { title: [{ type: "text", text: { content: task.name } }] },
          "Status":       { select: { name: "Not Started" } },
          "Priority":     { select: { name: task.priority || "Medium" } },
          "Phase Stage":  { select: { name: `Phase ${template.no}` } },
          "Phase":        { relation: [{ id: phaseId }] },
          "Project":      { relation: [{ id: projectId }] },
          "Task No.":     { number: i + 1 },
        },
      }
      const taskPage = await createPage(taskBody, token)
      tasksCreated.push(taskPage.id.replace(/-/g, ""))
    }
  }

  // Link all phases back to the project (Notion relations are bidirectional but
  // we set explicitly to be safe)
  await patchPage(projectId, {
    "Phases": { relation: phasesCreated.map(id => ({ id })) },
  }, token)

  // Set Phase 1 to In Progress (build has started)
  if (phasesCreated[0]) {
    await patchPage(phasesCreated[0], {
      "Status": { select: { name: "In Progress" } },
    }, token)
  }

  console.log(`[setup_project] Done: ${phasesCreated.length} phases, ${tasksCreated.length} tasks for project ${projectId}`)

  return {
    status:         "success",
    project_id:     projectId,
    phases_created: phasesCreated.length,
    tasks_created:  tasksCreated.length,
    target_date:    projectTargetDate,
    custom_tasks:   customPh2Tasks.length,
  }
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
