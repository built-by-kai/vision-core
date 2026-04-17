// Vercel Serverless Function — Content Production Stats
// Returns broad overview stats for the stat card widget

import { getClientByToken, getNotionToken, resolveDB, resolveField, resolveLabel } from "../../../lib/supabase"


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  // Token auth: resolves per-client Notion key from Supabase (no env var per client)
  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })
  const NOTION_KEY = getNotionToken(client)
  const CONTENT_DB   = resolveDB(client, 'CONTENT_DB',   '3188b289e31a80e39bbbf1c01ffdd56b')
  const TASKS_DB     = resolveDB(client, 'TASKS_DB',     '3348b289e31a80dc89e1eb7ba5b49b1a')
  // Accept either key name; EMPLOYEES_DB takes priority over legacy EMPLOYEE_DB
  const EMPLOYEES_DB = resolveDB(client, 'EMPLOYEES_DB', null) || resolveDB(client, 'EMPLOYEE_DB', null)

  // ── Field name mapping (per-client overrides via Supabase field_map) ──────
  const F = {
    CONTENT_STATUS:     resolveField(client, 'CONTENT_STATUS',     'Content Status'),
    CONTENT_DUE:        resolveField(client, 'CONTENT_DUE',        'Content Due'),
    PUBLISH_DUE:        resolveField(client, 'PUBLISH_DUE',        'Publish Due'),
    CONTENT_ASSIGNED:   resolveField(client, 'CONTENT_ASSIGNED',   'Assigned To'),
    CAMPAIGN:           resolveField(client, 'CAMPAIGN',           'Campaign'),
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

    // employeeMap built lazily after task pages are fetched (see below)
    let employeeMap = {}; // { notionPageId → displayName }

    // Resolve assignee names from People, Relation, or Rollup-of-relations field
    const getAssignees = prop => {
      if (!prop) return [];
      if (prop.type === 'people')   return (prop.people   || []).map(u => u.name).filter(Boolean);
      if (prop.type === 'relation') return (prop.relation || []).map(r => employeeMap[r.id]).filter(Boolean);
      if (prop.type === 'rollup' && prop.rollup?.type === 'array') {
        const ids = [];
        for (const item of prop.rollup.array || []) {
          if (item.type === 'relation') for (const r of item.relation || []) ids.push(r.id);
        }
        return [...new Set(ids)].map(id => employeeMap[id]).filter(Boolean);
      }
      return [];
    };

    const now       = new Date();
    const todayStr  = now.toISOString().slice(0, 10);
    const in7Days   = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);

    // Fetch all content (Done is needed for status panel count) + non-Done tasks in parallel
    const [contentPages, taskPages] = await Promise.all([
      queryAll(CONTENT_DB),
      queryAll(TASKS_DB, {
        property: 'Task Status',
        status: { does_not_equal: 'Done' },
      }).catch(() => []),
    ]);

    // ── Build employee map: collect unique relation IDs from Tasks "Assigned To",
    //    then fetch each page individually. This works even when the Employees DB
    //    itself is not shared with the integration (individual page access is separate).
    {
      const assignedField = 'Assigned To'; // Creaitors Tasks DB field name
      const seenIds = new Set();
      for (const page of taskPages) {
        const prop = page.properties[assignedField] || page.properties[F.CONTENT_ASSIGNED];
        if (prop?.type === 'relation') {
          for (const r of prop.relation || []) seenIds.add(r.id);
        }
        if (prop?.type === 'people') {
          for (const u of prop.people || []) {
            if (u.id && u.name) employeeMap[u.id] = u.name;
          }
        }
      }
      // Fetch any relation IDs we don't already have names for
      const idsToFetch = [...seenIds].filter(id => !employeeMap[id]);
      if (idsToFetch.length > 0) {
        const fetched = await Promise.all(
          idsToFetch.map(id =>
            fetch(`https://api.notion.com/v1/pages/${id}`, { headers })
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          )
        );
        for (const ep of fetched) {
          if (!ep || !ep.id) continue;
          const titleProp = Object.values(ep.properties || {}).find(v => v.type === 'title');
          const name = titleProp ? (titleProp.title || []).map(t => t.plain_text).join('') : '';
          if (name) employeeMap[ep.id] = name;
        }
      }
    }

    // ── Content stats ──────────────────────────────────────────
    let contentInMotion          = 0;
    let contentLinkedToCampaign  = 0;
    let contentRevision          = 0;
    let contentQC                = 0;
    let contentOverdue           = 0;
    let contentDueThisWeek       = 0;
    const assigneeCounts         = {};
    const contentStatusCounts    = {};

    for (const page of contentPages) {
      const p      = page.properties;
      const status = getStatus(p[F.CONTENT_STATUS]);
      if (!status) continue;

      // Always count every status (including Done) for the breakdown display
      contentStatusCounts[status] = (contentStatusCounts[status] || 0) + 1;

      // Active/motion stats exclude Done
      if (status === L.contentDone) continue;

      if (ACTIVE_STATUSES.includes(status)) contentInMotion++;
      if (status === L.contentRevision)     contentRevision++;
      if (status === L.contentQC)           contentQC++;

      // Check if linked to a campaign
      const campaignRel = p[F.CAMPAIGN]?.relation || [];
      if (campaignRel.length > 0) contentLinkedToCampaign++;

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

      // Count active tasks per assignee (from Tasks DB "Assigned To" relation/people)
      if (status !== L.taskDone) {
        const taskPeople = getAssignees(p['Assigned To'] || p[F.CONTENT_ASSIGNED]);
        for (const name of taskPeople) {
          assigneeCounts[name] = (assigneeCounts[name] || 0) + 1;
        }
      }

      const dueDate = getDate(p[F.TASK_DUE]);
      if (dueDate) {
        if (dueDate < todayStr)        tasksOverdue++;
        else if (dueDate === todayStr) tasksDueToday++;
        else if (dueDate <= in7Days)   tasksDueThisWeek++;
      }
    }

    // Sort assignees by count desc, cap at 8
    const byAssignee = Object.entries(assigneeCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return res.status(200).json({
      // Card 1: Content in Motion
      contentInMotion,
      contentLinkedToCampaign,
      contentBreakdown: { revision: contentRevision, qc: contentQC },
      byAssignee,

      // Card 2: Active Tasks
      tasksTotal,
      tasksBreakdown: { waiting: tasksWaiting, inProgress: tasksInProgress, qc: tasksQC, revision: tasksRevision },

      // Dynamic task status list (ordered, includes Done)
      taskStatuses,
      taskStatusCounts,
      taskDoneStatus: L.taskDone,

      // Content status breakdown
      contentStatuses,
      contentStatusCounts,

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
