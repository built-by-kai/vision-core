// /api/data/progress — Project completion progress
// GET ?project=<project_page_id>
// Returns phase & task completion data + active tasks with assignees
import { getPage, queryDB, plain, DB } from "../../../lib/notion"

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60")

  const projectId = (req.query.project || "").replace(/-/g, "")
  if (!projectId) return res.status(400).json({ error: "Missing ?project= parameter" })

  const token = process.env.NOTION_API_KEY
  try {
    // 1. Fetch project
    const project = await getPage(projectId, token)
    const props = project.properties || {}

    const projectName  = plain(props["Project Name"]?.title || props["Name"]?.title || [])
    const status       = props["Status"]?.select?.name || ""
    const packageType  = props["Package"]?.select?.name || ""
    const currentPhase = props["Phase"]?.select?.name || ""
    const startDate    = props["Start Date"]?.date?.start || null
    const targetDate   = props["Targeted Completion"]?.date?.start || null

    // 2. Get all phases linked to this project
    const phaseRels = props["Phases"]?.relation || []
    if (!phaseRels.length) {
      return res.json({
        project: { id: projectId, name: projectName, status, package: packageType, currentPhase, startDate, targetDate },
        phases: [],
        activeTasks: [],
        upcomingTasks: [],
        overall: { total: 0, done: 0, inProgress: 0, pct: 0 },
      })
    }

    // 3. Fetch all phases in parallel
    const phasePages = await Promise.all(
      phaseRels.map(r => getPage(r.id.replace(/-/g, ""), token).catch(() => null))
    )

    const phases = []
    const allTaskDetails = [] // collect every task for active/upcoming
    let totalTasks = 0, doneTasks = 0, inProgressTasks = 0

    for (const ph of phasePages) {
      if (!ph) continue
      const pp = ph.properties || {}
      const phaseNo     = pp["Phase No."]?.number ?? 99
      const phaseName   = plain(pp["Phase Name"]?.title || [])
      const phaseStatus = pp["Status"]?.status?.name || pp["Status"]?.select?.name || "Not Started"
      const startDt     = pp["Start Date"]?.date?.start || null
      const dueDt       = pp["Due Date"]?.date?.start || null
      const completedDt = pp["Completed Date"]?.date?.start || null

      // Get sub-items (tasks) for this phase
      const subItems = pp["Sub-item"]?.relation || []
      let taskTotal = subItems.length
      let taskDone = 0, taskInProgress = 0, taskNotStarted = 0

      if (subItems.length) {
        const taskPages = await Promise.all(
          subItems.map(r => getPage(r.id.replace(/-/g, ""), token).catch(() => null))
        )
        for (const t of taskPages) {
          if (!t) continue
          const tp = t.properties || {}
          const ts = tp.Status?.status?.name || tp.Status?.select?.name || "Not Started"
          if (ts === "Done") taskDone++
          else if (ts === "In Progress") taskInProgress++
          else taskNotStarted++

          // Extract task details for active/upcoming lists
          const assignees = (tp.Assignee?.people || []).map(p => ({
            name: p.name || "",
            avatar: p.avatar_url || "",
          }))

          allTaskDetails.push({
            id: t.id.replace(/-/g, ""),
            name: plain(tp["Phase Name"]?.title || []),
            status: ts,
            priority: tp.Priority?.select?.name || null,
            dueDate: tp["Due Date"]?.date?.start || null,
            assignees,
            phaseNo,
            phaseName,
          })
        }
      }

      totalTasks += taskTotal
      doneTasks += taskDone
      inProgressTasks += taskInProgress

      phases.push({
        no: phaseNo,
        name: phaseName,
        status: phaseStatus,
        startDate: startDt,
        dueDate: dueDt,
        completedDate: completedDt,
        tasks: { total: taskTotal, done: taskDone, inProgress: taskInProgress, notStarted: taskNotStarted },
        pct: taskTotal > 0 ? Math.round((taskDone / taskTotal) * 100) : 0,
      })
    }

    // Sort
    phases.sort((a, b) => a.no - b.no)

    // Active tasks: In Progress, sorted by due date
    const activeTasks = allTaskDetails
      .filter(t => t.status === "In Progress")
      .sort((a, b) => (a.dueDate || "9").localeCompare(b.dueDate || "9"))

    // Upcoming tasks: Not Started from the current active phase or first incomplete phase, + next phase
    const activePhase = phases.find(p => p.status === "In Progress")
    const firstIncomplete = phases.find(p => p.status !== "Done")
    const refPhaseNo = activePhase?.no ?? firstIncomplete?.no ?? 0
    const upcomingTasks = allTaskDetails
      .filter(t => t.status === "Not Started" && t.phaseNo <= refPhaseNo + 1)
      .sort((a, b) => (a.dueDate || "9").localeCompare(b.dueDate || "9"))
      .slice(0, 5)

    const overallPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0

    return res.json({
      project: {
        id: projectId,
        name: projectName,
        status,
        package: packageType,
        currentPhase,
        startDate,
        targetDate,
      },
      phases,
      activeTasks,
      upcomingTasks,
      overall: {
        total: totalTasks,
        done: doneTasks,
        inProgress: inProgressTasks,
        pct: overallPct,
      },
    })
  } catch (e) {
    console.error("[progress]", e)
    return res.status(500).json({ error: e.message })
  }
}
