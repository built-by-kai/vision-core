// Vercel Serverless Function — Content Production Stats
// Returns broad overview stats for the stat card widget

import { getClientByToken, getNotionToken, resolveDB } from "../../../lib/supabase"


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
  const CONTENT_DB = resolveDB(client, 'CONTENT_DB', '3188b289e31a80e39bbbf1c01ffdd56b')
  const TASKS_DB = resolveDB(client, 'TASKS_DB', '3348b289e31a80dc89e1eb7ba5b49b1a')

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

    const now       = new Date();
    const todayStr  = now.toISOString().slice(0, 10);
    const in7Days   = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);

    // Fetch all content (Done needed for status panel) + tasks that are:
    // - not Done, not Not started, AND must have a Content Production relation
    const [contentPages, taskPages] = await Promise.all([
      queryAll(CONTENT_DB),
      queryAll(TASKS_DB, {
        and: [
          { property: 'Task Status', status: { does_not_equal: 'Done' } },
          { property: 'Task Status', status: { does_not_equal: 'Not started' } },
          { property: 'Content Production', relation: { is_not_empty: true } },
        ],
      }).catch(() => []),
    ]);

    // ── Content stats ──────────────────────────────────────────
    const ACTIVE_STATUSES = ['Pre-Production', 'In Production', 'Revision Needed', 'Final QC Review', 'Scripting', 'Recording', 'Editing'];

    let contentInMotion    = 0;
    let contentRevision    = 0;
    let contentQC          = 0;
    let contentOverdue     = 0;
    let contentDueThisWeek = 0;
    const contentStatusCounts = {};

    for (const page of contentPages) {
      const p      = page.properties;
      const status = getStatus(p['Content Status']);
      if (!status) continue;

      // Always count for status breakdown (including Done)
      contentStatusCounts[status] = (contentStatusCounts[status] || 0) + 1;

      // Active stats exclude Done
      if (status === 'Done') continue;

      if (ACTIVE_STATUSES.includes(status)) contentInMotion++;
      if (status === 'Revision Needed')     contentRevision++;
      if (status === 'Final QC Review')     contentQC++;

      const deadline = getDate(p['Content Due']) || getDate(p['Publish Due']);
      if (deadline) {
        if (deadline < todayStr) contentOverdue++;
        else if (deadline <= in7Days) contentDueThisWeek++;
      }
    }

    // ── Task stats ─────────────────────────────────────────────
    // Creaitors task statuses (tasks are created via automation as Ready to Work or Waiting — Not started is never used)
    const CREAITORS_TASK_STATUSES = ['Waiting', 'Ready to Work', 'In progress', 'Pending QC Review', 'Review Needed', 'Ready for Posting'];

    let tasksTotal       = 0;
    let tasksWaiting     = 0;
    let tasksInProgress  = 0;
    let tasksQC          = 0;
    let tasksRevision    = 0;
    let tasksDueThisWeek = 0;
    let tasksOverdue     = 0;
    const taskStatusCounts = {};

    for (const page of taskPages) {
      const p      = page.properties;
      const status = getStatus(p['Task Status']);
      if (!status) continue;

      tasksTotal++;
      taskStatusCounts[status] = (taskStatusCounts[status] || 0) + 1;

      if (status === 'Waiting')              tasksWaiting++;
      if (status === 'Ready to Work' || status === 'In progress') tasksInProgress++;
      if (status === 'Pending QC Review')    tasksQC++;
      if (status === 'Review Needed')        tasksRevision++;

      const dueDate = getDate(p['Task Due']);
      if (dueDate) {
        if (dueDate < todayStr)      tasksOverdue++;
        else if (dueDate <= in7Days) tasksDueThisWeek++;
      }
    }

    // Ordered status lists for display
    const CONTENT_STATUS_ORDER = ['Pre-Production', 'In Production', 'Final QC Review', 'Revision Needed', 'Ready for Posting'];
    // Only include task statuses that actually have tasks — keeps the panel clean
    const TASK_STATUS_ORDER = CREAITORS_TASK_STATUSES.filter(s => (taskStatusCounts[s] || 0) > 0);

    return res.status(200).json({
      // Card 1: Content in Motion
      contentInMotion,
      contentBreakdown: { revision: contentRevision, qc: contentQC },

      // Card 2: Active Tasks
      tasksTotal,
      tasksBreakdown: { waiting: tasksWaiting, inProgress: tasksInProgress, qc: tasksQC, revision: tasksRevision },

      // Card 3: Due This Week
      dueThisWeek: contentDueThisWeek + tasksDueThisWeek,
      dueBreakdown: { content: contentDueThisWeek, tasks: tasksDueThisWeek },

      // Card 4: Needs Attention
      needsAttention: contentRevision + contentQC + tasksQC + tasksRevision + contentOverdue + tasksOverdue,
      attentionBreakdown: {
        overdue: contentOverdue + tasksOverdue,
        revision: contentRevision + tasksRevision,
        qc: contentQC + tasksQC,
      },

      // Status breakdowns for display panels
      contentStatusCounts,
      contentStatuses: CONTENT_STATUS_ORDER,
      taskStatusCounts,
      taskStatuses: TASK_STATUS_ORDER,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
