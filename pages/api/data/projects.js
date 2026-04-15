// /api/data/projects — token-authenticated
// GET: Returns project counts, active builds with per-phase task breakdowns
// POST: Task actions (start_task, complete_task)
import { queryDB, plain, hdrs, patchPage, DB } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB, resolveField } from "../../../lib/supabase"

function actionHTML(title, msg, ok) {
  const bg = ok ? "#0a0a0a" : "#1a0a0a"
  const accent = ok ? "#AAFF00" : "#FF4444"
  const icon = ok ? "✓" : "✕"
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;background:${bg};color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#191919;border:1px solid ${accent}22;border-radius:16px;padding:40px;max-width:400px;text-align:center}
.icon{width:56px;height:56px;border-radius:50%;background:${accent}18;color:${accent};display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;margin-bottom:16px}
h1{font-size:20px;font-weight:700;margin-bottom:8px}p{font-size:14px;color:rgba(255,255,255,.6);line-height:1.5}
.hint{margin-top:20px;font-size:12px;color:rgba(255,255,255,.3)}</style></head>
<body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${msg}</p><p class="hint">You can close this tab and return to Notion.</p></div></body></html>`
}

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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-widget-token")

  // ── POST: Task actions (start_task, complete_task) ────────────────────────
  // Supports: widget JSON body {action, taskId} OR Notion webhook {do= query param, page_id in body}
  if (req.method === "POST") {
    try {
      const accessToken = req.query.token || req.headers["x-widget-token"]
      if (!accessToken) return res.status(401).json({ error: "Missing token" })
      const client = await getClientByToken(accessToken)
      if (!client) return res.status(403).json({ error: "Invalid token" })
      const notionToken = getNotionToken(client)

      const body = req.body || {}
      const now = new Date()
      const nowISO = now.toISOString() // full datetime with time

      // Helper: validate that userId (if provided) is an assignee on the task
      async function validateAssignee(taskPageId, userId) {
        if (!userId) return true // skip check if no userId provided (e.g. Notion webhook)
        try {
          const res = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, { headers: hdrs(notionToken) })
          if (!res.ok) return true // if we can't fetch, don't block the action
          const page = await res.json()
          const people = page.properties?.["Assigned To"]?.people || page.properties?.Assignee?.people || []
          if (!people.length) return true // no assignees = anyone can act
          return people.some(p => p.id === userId || p.person?.email === userId)
        } catch { return true }
      }

      // ── Mode 1: Notion webhook button — action from ?do= query, page ID from body ──
      if (req.query.do) {
        const pageId = body.data?.page_id || body.data?.id || body.page_id || body.id
          || body.source?.page_id || body.taskId || null
        if (!pageId) return res.status(400).json({ error: "Could not find page_id in webhook payload", received: Object.keys(body) })

        // Notion webhooks include user context — validate if available
        const webhookUserId = body.data?.user_id || body.source?.user_id || body.user_id || null
        const allowed = await validateAssignee(pageId, webhookUserId)
        if (!allowed) return res.status(403).json({ error: "Only the assigned team member can perform this action" })

        if (req.query.do === "start") {
          await patchPage(pageId, {
            "Start Date": { date: { start: nowISO } },
            "Status":     { status: { name: "In Progress" } },
          }, notionToken)
          return res.status(200).json({ ok: true, action: "start_task", pageId, date: nowISO })
        }
        if (req.query.do === "complete") {
          await patchPage(pageId, {
            "Completed Date": { date: { start: nowISO } },
            "Status":         { status: { name: "Done" } },
          }, notionToken)
          return res.status(200).json({ ok: true, action: "complete_task", pageId, date: nowISO })
        }
        return res.status(400).json({ error: "Unknown action: " + req.query.do })
      }

      // ── Mode 2: Widget / direct JSON body {action, taskId, userId} ──
      const { action, taskId, userId } = body
      if (!action || !taskId) return res.status(400).json({ error: "Missing action or taskId" })

      // Validate assignee if userId provided
      const allowed = await validateAssignee(taskId, userId)
      if (!allowed) return res.status(403).json({ error: "Only the assigned team member can perform this action" })

      if (action === "start_task") {
        await patchPage(taskId, {
          "Start Date": { date: { start: nowISO } },
          "Status":     { status: { name: "In Progress" } },
        }, notionToken)
        return res.status(200).json({ ok: true, action: "start_task", date: nowISO })
      }

      if (action === "complete_task") {
        await patchPage(taskId, {
          "Completed Date": { date: { start: nowISO } },
          "Status":         { status: { name: "Done" } },
        }, notionToken)
        return res.status(200).json({ ok: true, action: "complete_task", date: nowISO })
      }

      return res.status(400).json({ error: "Unknown action: " + action })
    } catch (err) {
      console.error("projects POST:", err)
      return res.status(500).json({ error: err.message })
    }
  }

  // ── GET: Quick actions (do=start|complete, task=ID) ───────────────────────
  if (req.query.do && req.query.task) {
    try {
      const accessToken = req.query.token || req.headers["x-widget-token"]
      if (!accessToken) return res.status(401).send(actionHTML("Error", "Missing token", false))
      const client = await getClientByToken(accessToken)
      if (!client) return res.status(403).send(actionHTML("Error", "Invalid token", false))
      const notionToken = getNotionToken(client)
      const taskId = req.query.task
      const nowISO = new Date().toISOString()
      const fmtTime = new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" })

      if (req.query.do === "start") {
        await patchPage(taskId, {
          "Start Date": { date: { start: nowISO } },
          "Status":     { status: { name: "In Progress" } },
        }, notionToken)
        return res.status(200).send(actionHTML("Task Started", `Status → In Progress · Start Date → ${fmtTime}`, true))
      }
      if (req.query.do === "complete") {
        await patchPage(taskId, {
          "Completed Date": { date: { start: nowISO } },
          "Status":         { status: { name: "Done" } },
        }, notionToken)
        return res.status(200).send(actionHTML("Task Completed", `Status → Done · Completed Date → ${fmtTime}`, true))
      }
      return res.status(400).send(actionHTML("Error", "Unknown action: " + req.query.do, false))
    } catch (err) {
      console.error("projects action:", err)
      return res.status(500).send(actionHTML("Error", err.message, false))
    }
  }

  // ── GET: Project data ─────────────────────────────────────────────────────
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
      // Assignee: pick from "Assigned To" or "Assignee" people field
      const rawPeople = p["Assigned To"]?.people || p.Assignee?.people || []
      const assignees = rawPeople
        .map(u => ({
          name: u.name || u.person?.email?.split("@")[0] || "",
          avatar: u.avatar_url || null,
        }))
        .filter(a => a.name)
      taskMap[id] = {
        name:       plain(p["Task Name"]?.title || []) || "",
        status:     p.Status?.status?.name || p.Status?.select?.name || "Not Started",
        priority:   p.Priority?.select?.name || "",
        phaseId:    strip(p.Phase?.relation?.[0]?.id || ""),
        phaseStage: p["Phase Stage"]?.select?.name || "",
        due:        p["Due Date"]?.date?.start || null,
        plannedStart: p["Planned Start"]?.date?.start || null,
        startDate:  p["Start Date"]?.date?.start || null,
        completedDate: p["Completed Date"]?.date?.start || null,
        milestone:  p["Milestone"]?.checkbox || false,
        blockedBy:  (p["Blocked by"]?.relation || []).map(r => strip(r.id)),
        assignees,
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
      const status   = p.Status?.status?.name || p.Status?.select?.name || ""
      const name     = plain(p["Project Name"]?.title || p.Name?.title || []) || "Untitled"
      const compRel  = strip(p.Company?.relation?.[0]?.id || "")
      const company  = compRel ? (companyNames[compRel] || "") : ""
      const pkg      = p.Package?.select?.name || p[packageField]?.select?.name || ""
      const projId   = strip(proj.id)
      const curPhase = p.Phase?.select?.name || ""
      const startDate = p["Start Date"]?.date?.start || null
      const targetDate = p["Targeted Completion"]?.date?.start || p["Target Date"]?.date?.start || p["Target End Date"]?.date?.start || null
      const completedDate = p["Completed Date"]?.date?.start || p["Date Completed"]?.date?.start || null
      const notionUrl = proj.url || null

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
        completedDate,
        notionUrl,
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

    // ── Overview aggregates ───────────────────────────────────────────────
    const allEntries = [...builds, ...completed]
    const totalProjects = projects.length

    // Project type distribution
    const typeCount = {}
    for (const e of allEntries) {
      const t = e.type || "Unspecified"
      typeCount[t] = (typeCount[t] || 0) + 1
    }
    const projectTypes = Object.entries(typeCount)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, pct: Math.round((count / (totalProjects || 1)) * 100) }))

    // Aggregate task stats across ALL projects
    const aggTasks = { total: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0 }
    for (const e of allEntries) {
      const ts = e.taskSummary || {}
      aggTasks.total += ts.total || 0
      aggTasks.done += ts.done || 0
      aggTasks.inProgress += ts.inProgress || 0
      aggTasks.blocked += ts.blocked || 0
      aggTasks.notStarted += ts.notStarted || 0
    }
    aggTasks.completionPct = aggTasks.total > 0 ? Math.round((aggTasks.done / aggTasks.total) * 100) : 0

    // Priority distribution from taskMap
    const priorities = { High: 0, Medium: 0, Low: 0, None: 0 }
    for (const t of Object.values(taskMap)) {
      const pri = t.priority
      if (pri === "High" || pri === "Urgent") priorities.High++
      else if (pri === "Medium") priorities.Medium++
      else if (pri === "Low") priorities.Low++
      else priorities.None++
    }

    // Average completion across active projects
    const activeBuilds = builds.filter(b => b.status === "active")
    const avgCompletion = activeBuilds.length > 0
      ? Math.round(activeBuilds.reduce((s, b) => s + (b.overallPct || 0), 0) / activeBuilds.length)
      : 0

    // Task timeline: group tasks by date for status trend chart
    const taskTimeline = {}
    for (const t of Object.values(taskMap)) {
      // Track completed tasks by completion date
      if (t.status === "Done" && t.completedDate) {
        if (!taskTimeline[t.completedDate]) taskTimeline[t.completedDate] = { done: 0, started: 0 }
        taskTimeline[t.completedDate].done++
      }
      // Track started tasks by start date
      if (t.startDate) {
        if (!taskTimeline[t.startDate]) taskTimeline[t.startDate] = { done: 0, started: 0 }
        taskTimeline[t.startDate].started++
      }
    }
    const timeline = Object.entries(taskTimeline)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, counts]) => ({ date, ...counts }))

    const overview = {
      totalProjects,
      avgCompletion,
      projectTypes,
      taskStats: aggTasks,
      priorities,
      timeline,
    }

    // ── Gantt view: return task-level data with dates ─────────────────────
    if (req.query.view === "gantt") {
      const ganttProjects = [...builds, ...completed].map(b => {
        // Collect tasks for this project from projTaskLookup + relation
        const projPage = projects.find(pr => {
          const n = plain(pr.properties["Project Name"]?.title || pr.properties.Name?.title || [])
          return n === b.name
        })
        const pid = projPage ? strip(projPage.id) : ""
        const tIds = new Set([
          ...((projPage?.properties.Tasks?.relation || []).map(r => strip(r.id))),
          ...(projTaskLookup[pid] || []),
        ])

        const ganttTasks = []
        for (const tid of tIds) {
          const t = taskMap[tid]
          if (!t) continue
          ganttTasks.push({
            id: tid,
            name: t.name,
            status: t.status,
            priority: t.priority,
            phase: t.phaseStage || "",
            due: t.due,
            plannedStart: t.plannedStart || null,
            startDate: t.startDate || null,
            completedDate: t.completedDate || null,
            milestone: t.milestone || false,
            blockedBy: t.blockedBy || [],
            assignees: t.assignees || [],
            created: null, // filled below
          })
        }

        // Fetch created_time from raw tasks
        for (const rawTask of tasks) {
          const rtid = strip(rawTask.id)
          const gt = ganttTasks.find(g => g.id === rtid)
          if (gt) gt.created = rawTask.created_time?.split("T")[0] || null
        }

        // Sort tasks by phase then due date
        const phaseOrder = {}
        for (const ph of b.phases || []) phaseOrder[ph.name] = ph.no ?? 99
        ganttTasks.sort((a, b2) => {
          const pa = phaseOrder[a.phase] ?? 99, pb = phaseOrder[b2.phase] ?? 99
          if (pa !== pb) return pa - pb
          if (a.due && b2.due) return a.due.localeCompare(b2.due)
          return a.due ? -1 : 1
        })

        return {
          name: b.name,
          client: b.client,
          type: b.type,
          status: b.status,
          startDate: b.startDate,
          targetDate: b.targetDate,
          phases: (b.phases || []).map(ph => ({ name: ph.name, no: ph.no })),
          tasks: ganttTasks,
        }
      })

      return res.status(200).json({ gantt: ganttProjects })
    }

    // ── Team view: per-member task stats ───────────────────────────────────
    if (req.query.view === "team") {
      const members = {} // name → { avatar, assigned, done, inProgress, blocked, notStarted, totalDurationDays, completedWithDuration }
      for (const t of Object.values(taskMap)) {
        for (const a of (t.assignees || [])) {
          const key = a.name
          if (!members[key]) members[key] = { name: a.name, avatar: a.avatar, assigned: 0, done: 0, inProgress: 0, blocked: 0, notStarted: 0, totalDurationDays: 0, completedWithDuration: 0 }
          const m = members[key]
          m.assigned++
          if (t.status === "Done") {
            m.done++
            // Calculate duration if both dates exist
            if (t.startDate && t.completedDate) {
              const start = new Date(t.startDate + "T00:00:00")
              const end = new Date(t.completedDate + "T00:00:00")
              const days = Math.max(Math.round((end - start) / 86400000), 0)
              m.totalDurationDays += days
              m.completedWithDuration++
            }
          }
          else if (t.status === "In Progress") m.inProgress++
          else if (t.status === "Blocked") m.blocked++
          else m.notStarted++
        }
      }

      const team = Object.values(members).map(m => ({
        ...m,
        completionRate: m.assigned > 0 ? Math.round((m.done / m.assigned) * 100) : 0,
        avgDurationDays: m.completedWithDuration > 0 ? Math.round(m.totalDurationDays / m.completedWithDuration * 10) / 10 : null,
      })).sort((a, b) => b.assigned - a.assigned)

      return res.status(200).json({ team, totalTasks: Object.keys(taskMap).length })
    }

    res.status(200).json({ counts, builds, completed, overview })
  } catch (err) {
    console.error("projects:", err)
    res.status(500).json({ error: err.message })
  }
}
