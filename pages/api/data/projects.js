// /api/data/projects — token-authenticated
// Returns project counts, active builds with per-phase task breakdowns
import { queryDB, plain, hdrs, DB } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB, resolveField } from "../../../lib/supabase"

async function fetchPageTitle(pageId, token) {
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: hdrs(token) })
    if (!res.ok) return ""
    const data = await res.json()
    const p = data.properties || {}
    for (const key of ["Name", "Company Name", "Title"]) {
      const prop = p[key]
      if (prop?.type === "title" && prop.title?.length) return plain(prop.title)
    }
    for (const prop of Object.values(p)) {
      if (prop?.type === "title" && prop.title?.length) return plain(prop.title)
    }
    return ""
  } catch { return "" }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })

    const notionToken  = getNotionToken(client)
    const PROJECTS_DB  = resolveDB(client, "PROJECTS", DB.PROJECTS)
    const PHASES_DB    = resolveDB(client, "PHASES",   DB.PHASES)
    const TASKS_DB     = resolveDB(client, "TASKS",    DB.TASKS)
    const statusField  = resolveField(client, "STATUS_FIELD",  "Status")
    const packageField = resolveField(client, "PACKAGE_FIELD", "Package Type")

    // ── Fetch all three databases in parallel ──────────────────────────────
    const [projects, phases, tasks] = await Promise.all([
      queryDB(PROJECTS_DB, null, notionToken),
      queryDB(PHASES_DB,   null, notionToken),
      queryDB(TASKS_DB,    null, notionToken),
    ])

    // ── Build lookup maps ──────────────────────────────────────────────────
    const strip = id => (id || "").replace(/-/g, "")

    // Phase map: phaseId → { name, no, status, due, taskIds }
    const phaseMap = {}
    for (const ph of phases) {
      const p = ph.properties
      const id = strip(ph.id)
      phaseMap[id] = {
        name:   plain(p["Phase Name"]?.title || []) || "Untitled Phase",
        no:     p["Phase No."]?.number ?? 99,
        status: p[statusField]?.select?.name || p[statusField]?.status?.name || "Not Started",
        due:    p["Due Date"]?.date?.start || null,
        taskIds: new Set((p.Tasks?.relation || []).map(r => strip(r.id))),
      }
    }

    // Task map: taskId → { status, priority, phaseId, phaseStage, due, name }
    // Also build reverse map: projectId → Set of taskIds (from task's Project relation)
    const taskMap = {}
    const projTaskLookup = {}   // projectId → Set<taskId>
    for (const t of tasks) {
      const p = t.properties
      const id = strip(t.id)
      taskMap[id] = {
        name:       plain(p["Task Name"]?.title || []) || "",
        status:     p.Status?.status?.name || p.Status?.select?.name || "Not Started",
        priority:   p.Priority?.select?.name || "",
        phaseId:    strip(p.Phase?.relation?.[0]?.id || ""),
        phaseStage: p["Phase Stage"]?.select?.name || "",  // fallback when Phase relation is empty
        due:        p["Due Date"]?.date?.start || null,
      }
      // Build reverse project → tasks map from task's Project relation
      for (const rel of (p.Project?.relation || [])) {
        const pid = strip(rel.id)
        if (!projTaskLookup[pid]) projTaskLookup[pid] = new Set()
        projTaskLookup[pid].add(id)
      }
    }

    // ── Company name lookups ───────────────────────────────────────────────
    const companyIds = new Set()
    for (const proj of projects) {
      const rel = proj.properties.Company?.relation?.[0]?.id
      if (rel) companyIds.add(rel)
    }
    const companyNames = {}
    await Promise.all([...companyIds].map(async id => {
      companyNames[strip(id)] = await fetchPageTitle(id, notionToken)
    }))

    // ── Process projects ───────────────────────────────────────────────────
    const counts = { active: 0, review: 0, done: 0, hold: 0, awaiting: 0 }
    const builds = []
    const completed = []

    for (const proj of projects) {
      const p        = proj.properties
      const status   = p.Status?.select?.name || ""
      const name     = plain(p["Project Name"]?.title || p.Name?.title || []) || "Untitled"
      const compRel  = strip(p.Company?.relation?.[0]?.id || "")
      const company  = compRel ? (companyNames[compRel] || "") : ""
      const pkg      = p.Package?.select?.name || p[packageField]?.select?.name || ""
      const projId   = strip(proj.id)
      const curPhase = p.Phase?.select?.name || ""
      const startDate = p["Start Date"]?.date?.start || null
      const targetDate = p["Target Date"]?.date?.start || p["Target End Date"]?.date?.start || null

      // Get task IDs: merge project's Tasks relation + reverse lookup from task's Project relation
      const projTaskIds = new Set([
        ...(p.Tasks?.relation || []).map(r => strip(r.id)),
        ...(projTaskLookup[projId] || []),
      ])

      // Build per-phase breakdown from tasks
      // Two modes: phase relation IDs (phaseTaskMap) OR Phase Stage select (stageTaskMap)
      const phaseTaskMap = {}   // phaseId → counts
      const stageTaskMap = {}   // "Phase 1" → counts
      let taskSummary = { total: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0 }

      for (const tid of projTaskIds) {
        const task = taskMap[tid]
        if (!task) continue
        taskSummary.total++

        const bucket =
          task.status === "Done" ? "done" :
          task.status === "In Progress" ? "inProgress" :
          task.status === "Blocked" ? "blocked" : "notStarted"
        taskSummary[bucket]++

        // Group by phase relation (preferred) or Phase Stage select (fallback)
        const phId = task.phaseId
        if (phId) {
          if (!phaseTaskMap[phId]) phaseTaskMap[phId] = { done: 0, inProgress: 0, blocked: 0, notStarted: 0, total: 0 }
          phaseTaskMap[phId].total++
          phaseTaskMap[phId][bucket]++
        } else if (task.phaseStage) {
          if (!stageTaskMap[task.phaseStage]) stageTaskMap[task.phaseStage] = { done: 0, inProgress: 0, blocked: 0, notStarted: 0, total: 0 }
          stageTaskMap[task.phaseStage].total++
          stageTaskMap[task.phaseStage][bucket]++
        }
      }

      // Build phases array with task counts
      const projectPhases = []
      const hasPhaseRelations = Object.keys(phaseTaskMap).length > 0

      if (hasPhaseRelations) {
        // Mode 1: real Phase relations exist — use phaseMap for details
        const projPhaseIds = new Set([
          ...(p.Phases?.relation || []).map(r => strip(r.id)),
          ...Object.keys(phaseTaskMap),
        ])
        for (const phId of projPhaseIds) {
          const ph = phaseMap[phId]
          if (!ph) continue
          const tc = phaseTaskMap[phId] || { done: 0, inProgress: 0, blocked: 0, notStarted: 0, total: 0 }
          const pct = tc.total > 0 ? Math.round((tc.done / tc.total) * 100) : 0
          projectPhases.push({
            id: phId, name: ph.name, no: ph.no, status: ph.status, due: ph.due, tasks: tc, pct,
          })
        }
      } else {
        // Mode 2: no Phase relations — synthesise from Phase Stage select
        const stageOrder = {}
        let idx = 0
        for (const stage of Object.keys(stageTaskMap).sort()) {
          const noMatch = stage.match(/Phase\s*(\d+)/)
          const no = noMatch ? parseInt(noMatch[1]) : idx
          const tc = stageTaskMap[stage]
          const pct = tc.total > 0 ? Math.round((tc.done / tc.total) * 100) : 0
          // Infer status: if any task is in-progress → In Progress, all done → Done, else Not Started
          let phStatus = "Not Started"
          if (tc.done === tc.total && tc.total > 0) phStatus = "Done"
          else if (tc.inProgress > 0 || tc.blocked > 0) phStatus = "In Progress"
          // Check if this matches the project's current Phase select to mark as In Progress
          if (curPhase && stage.includes(curPhase.replace(/Phase\s*/, "Phase "))) phStatus = "In Progress"

          projectPhases.push({
            id: stage, name: stage, no, status: phStatus, due: null, tasks: tc, pct,
          })
          idx++
        }
      }
      projectPhases.sort((a, b) => a.no - b.no)

      // Current active phase
      const activePhase = projectPhases.find(p => p.status === "In Progress")
        || projectPhases.find(p => p.status === "Not Started")
        || projectPhases[0]
      const overallPct = taskSummary.total > 0 ? Math.round((taskSummary.done / taskSummary.total) * 100) : 0

      // Bucket
      let bucket = ""
      if (["Build Started","Building","In Progress","Active"].includes(status))           bucket = "active"
      else if (["In Review","Client Review","Review"].includes(status))                    bucket = "review"
      else if (["Completed","Delivered","Done"].includes(status))                          bucket = "done"
      else if (["On Hold","Paused"].includes(status))                                      bucket = "hold"
      else if (["Awaiting Deposit","Awaiting Build","Balance Due"].includes(status))       bucket = "awaiting"

      if (bucket) counts[bucket]++

      const entry = {
        name,
        client: company,
        type: pkg,
        status: bucket,
        phase: activePhase?.name || curPhase || "—",
        phasePct: activePhase?.pct ?? 0,
        overallPct,
        startDate,
        targetDate,
        phases: projectPhases,
        taskSummary,
      }

      if (["active","review","hold","awaiting"].includes(bucket)) {
        builds.push(entry)
      } else if (bucket === "done") {
        completed.push(entry)
      }
    }

    const order = { active: 0, review: 1, awaiting: 2, hold: 3 }
    builds.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))

    res.status(200).json({ counts, builds, completed })
  } catch (err) {
    console.error("projects:", err)
    res.status(500).json({ error: err.message })
  }
}
