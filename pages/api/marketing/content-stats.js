// Vercel Serverless Function — Content Production Stats
// Returns broad overview stats for the stat card widget

import { getClientByToken, getNotionToken, resolveDB, resolveField, resolveLabel } from "../../../lib/supabase"


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  // Token auth: resolves per-client Notion key from Supabase (no env var per client)
  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })
  const NOTION_KEY = getNotionToken(client)
  const CONTENT_DB   = resolveDB(client, 'CONTENT_DB',   '3188b289e31a80e39bbbf1c01ffdd56b')
  const TASKS_DB     = resolveDB(client, 'TASKS_DB',     '3348b289e31a80dc89e1eb7ba5b49b1a')
  const EMPLOYEES_DB = resolveDB(client, 'EMPLOYEES_DB', null)  // null = use People field instead

  // ── Field name mapping (per-client overrides via Supabase field_map) ──────
  const F = {
    CONTENT_STATUS:     resolveField(client, 'CONTENT_STATUS',     'Content Status'),
    CONTENT_DUE:        resolveField(client, 'CONTENT_DUE',        'Content Due'),
    PUBLISH_DUE:        resolveField(client, 'PUBLISH_DUE',        'Publish Due'),
    CONTENT_ASSIGNED:   resolveField(client, 'CONTENT_ASSIGNED',   'Assigned To'),
    TASK_STATUS:        resolveField(client, 'TASK_STATUS',        'Task Status'),
    TASK_DUE:           resolveField(client, 'TASK_DUE',           'Task Due'),
    CONTENT_PRODUCTION: resolveField(client, 'CONTENT_PRODUCTION', 'Content Production'),
  }

  // ── Status label mapping (per-client overrides via Supabase labels) ───────
  const L = {
    contentDone:      resolveLabel(client, 'contentDoneStatus',      'Done'),
    contentRevision:  resolveLabel(client, 'contentRevisionStatus',  'Revision Needed'),
    contentQC:        resolveLabel(client, 'contentQCStatus',        'Final QC Review'),
    taskDone:         resolveLabel(client, 'taskDoneStatus',         'Done'),
    taskWaiting:      resolveLabel(client, 'taskWaitingStatus',      'Waiting'),
    taskInProgress:   resolveLabel(client, 'taskInProgressStatus',   'In progress'),
    taskReadyToWork:  resolveLabel(client, 'taskReadyToWorkStatus',  'Ready to Work'),
    taskNotStarted:   resolveLabel(client, 'taskNotStartedStatus',   'Not started'),
    taskQC:           resolveLabel(client, 'taskQCStatus',           'Pending QC Review'),
    taskRevision:     resolveLabel(client, 'taskRevisionStatus',     'Review Needed'),
  }
  const ACTIVE_STATUSES = client.labels?.contentActiveStatuses ||
    ['Pre-Production', 'In Production', 'Revision Needed', 'Final QC Review', 'Scripting', 'Recording', 'Editing']

  // ── Ordered status lists (per-client, drives dynamic widget rendering) ────
  const taskStatuses = client.labels?.taskStatuses ||
    ['Not Started', 'In Progress', 'Pending QC', 'Revision', 'Done']
  const contentStatuses = client.labels?.contentStatuses ||
    ['Pre-Production', 'In Production', 'Final QC Review', 'Revision Needed', 'Ready for Posting', 'Done']

  try {

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    async function queryAll(dbId, filter) {
      let all = [], hasMore = true, cursor;
      while (hasMore) {
        const body = { page_size: 100 };
        if (filter) body.filter = filter;
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST', headers, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`DB ${dbId} error (${r.status}): ${await r.text()}`);
        const d = await r.json();
        all = all.concat(d.results);
        hasMore = d.has_more;
        cursor = d.next_cursor;
      }
      return all;
    }

    const getStatus = p => p?.type === 'status' ? p.status?.name : null;
    const getDate   = p => p?.type === 'date'   ? p.date?.start : null;

    // Pre-fetch employees if client uses a relation-based assignee field
    let employeeMap = {}; // { notionPageId → displayName }
    if (EMPLOYEES_DB) {
      const empPages = await queryAll(EMPLOYEES_DB).catch(() => []);
      for (const ep of empPages) {
        const titleProp = Object.values(ep.properties).find(v => v.type === 'title');
        const name = titleProp ? (titleProp.title || []).map(t => t.plain_text).join('') : '';
        if (name) employeeMap[ep.id] = name;
      }
    }

    // Resolve assignee names from either a People field or a Relation-to-Employee field
    const getAssignees = prop => {
      if (!prop) return [];
      if (prop.type === 'people')   return (prop.people   || []).map(u => u.name).filter(Boolean);
      if (prop.type === 'relation') return (prop.relation || []).map(r => employeeMap[r.id]).filter(Boolean);
      return [];
    };

    const now       = new Date();
    const todayStr  = now.toISOString().slice(0, 10);
    const in7Days   = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);

    // Fetch all active content (not Done) and all active tasks (not Done) in parallel
    const [contentPages, taskPages] = await Promise.all([
      queryAll(CONTENT_DB, {
        property: F.CONTENT_STATUS, status: { does_not_equal: L.contentDone }
      }).catch(() => queryAll(CONTENT_DB)), // fallback: fetch all
      queryAll(TASKS_DB).catch(() => []),
    ]);

    // ── Content stats ──────────────────────────────────────────
    let contentInMotion   = 0;
    let contentRevision   = 0;
    let contentQC         = 0;
    let contentOverdue    = 0;
    let contentDueThisWeek= 0;
    const assigneeCounts  = {};

    for (const page of contentPages) {
      const p      = page.properties;
      const status = getStatus(p[F.CONTENT_STATUS]);
      if (!status || status === L.contentDone) continue;

      if (ACTIVE_STATUSES.includes(status)) contentInMotion++;
      if (status === L.contentRevision)     contentRevision++;
      if (status === L.contentQC)           contentQC++;

      // Count active content per assignee
      const people = getAssignees(p[F.CONTENT_ASSIGNED]);
      for (const name of people) {
        assigneeCounts[name] = (assigneeCounts[name] || 0) + 1;
      }

      const deadline = getDate(p[F.CONTENT_DUE]) || getDate(p[F.PUBLISH_DUE]);
      if (deadline) {
        if (deadline < todayStr) contentOverdue++;
        else if (deadline <= in7Days) contentDueThisWeek++;
      }
    }

    // Sort assignees by count desc, cap at 8
    const byAssignee = Object.entries(assigneeCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // ── Task stats ─────────────────────────────────────────────
    let tasksTotal       = 0;
    let tasksWaiting     = 0;
    let tasksInProgress  = 0;
    let tasksQC          = 0;
    let tasksRevision    = 0;
    let tasksDueThisWeek = 0;
    let tasksOverdue     = 0;
    let tasksDueToday    = 0;

    // Per-status counts for dynamic widget rendering (includes Done)
    const taskStatusCounts = {};
    for (const s of taskStatuses) taskStatusCounts[s] = 0;

    for (const page of taskPages) {
      const p      = page.properties;
      const status = getStatus(p[F.TASK_STATUS]);
      if (!status) continue;

      // Skip tasks not linked to any content production
      const contentRel = p[F.CONTENT_PRODUCTION]?.relation || [];
      if (contentRel.length === 0) continue;

      // Count per status (includes Done — for the full status list in the widget)
      if (Object.prototype.hasOwnProperty.call(taskStatusCounts, status)) {
        taskStatusCounts[status]++;
      }

      // Active tasks = non-done (for the big number)
      if (status === L.taskDone) continue;

      tasksTotal++;
      if (status === L.taskWaiting)                                                                   tasksWaiting++;
      if (status === L.taskReadyToWork || status === L.taskInProgress || status === L.taskNotStarted) tasksInProgress++;
      if (status === L.taskQC)                                                                        tasksQC++;
      if (status === L.taskRevision)                                                                  tasksRevision++;

      const dueDate = getDate(p[F.TASK_DUE]);
      if (dueDate) {
        if (dueDate < todayStr)        tasksOverdue++;
        else if (dueDate === todayStr) tasksDueToday++;
        else if (dueDate <= in7Days)   tasksDueThisWeek++;
      }
    }

    return res.status(200).json({
      // Card 1: Content in Motion
      contentInMotion,
      contentBreakdown: { revision: contentRevision, qc: contentQC },
      byAssignee,

      // Card 2: Active Tasks
      tasksTotal,
      tasksBreakdown: { waiting: tasksWaiting, inProgress: tasksInProgress, qc: tasksQC, revision: tasksRevision },

      // Dynamic task status list (ordered, includes Done)
      taskStatuses,
      taskStatusCounts,
      taskDoneStatus: L.taskDone,

      // Card 3: Due This Week
      dueThisWeek: contentDueThisWeek + tasksDueThisWeek,
      dueToday: tasksDueToday,
      dueBreakdown: { content: contentDueThisWeek, tasks: tasksDueThisWeek },

      // Card 4: Needs Attention
      needsAttention: contentRevision + contentQC + tasksQC + tasksRevision + contentOverdue + tasksOverdue,
      attentionBreakdown: {
        overdue: contentOverdue + tasksOverdue,
        revision: contentRevision + tasksRevision,
        qc: contentQC + tasksQC,
      },
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
