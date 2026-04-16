// Vercel Serverless Function — Bottlenecks (Needs Action)
// Queries Content Production DB + Tasks DB
// Employee Hub DB for name resolution

import { getClientByToken, getNotionToken, resolveDB, resolveField, resolveLabel } from "../../../../lib/supabase"


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
  const CONTENT_DB = resolveDB(client, 'CONTENT_DB', '3188b289e31a80e39bbbf1c01ffdd56b')
  const TASKS_DB = resolveDB(client, 'TASKS_DB', '3348b289e31a80dc89e1eb7ba5b49b1a')
  const EMPLOYEE_DB = resolveDB(client, 'EMPLOYEE_DB', 'bc5b99b59468498e8a294149d6f03134')

  // ── Field name mapping ────────────────────────────────────────────────────
  const F = {
    CONTENT_STATUS:     resolveField(client, 'CONTENT_STATUS',     'Content Status'),
    CONTENT_TITLE:      resolveField(client, 'CONTENT_TITLE',      'Content Title'),
    CONTENT_DUE:        resolveField(client, 'CONTENT_DUE',        'Content Due'),
    PUBLISH_DUE:        resolveField(client, 'PUBLISH_DUE',        'Publish Due'),
    CHANNEL:            resolveField(client, 'CHANNEL',            'Channel'),
    CONTENT_TYPE:       resolveField(client, 'CONTENT_TYPE',       'Content Type'),
    ASSIGNED_BY:        resolveField(client, 'ASSIGNED_BY',        'Assigned By'),
    CLIENT:             resolveField(client, 'CLIENT',             'Client'),
    CAMPAIGN:           resolveField(client, 'CAMPAIGN',           'Campaign'),
    TASK_TITLE:         resolveField(client, 'TASK_TITLE',         'Task List'),
    TASK_STATUS:        resolveField(client, 'TASK_STATUS',        'Task Status'),
    TASK_DUE:           resolveField(client, 'TASK_DUE',           'Task Due'),
    QC_NOTES:           resolveField(client, 'QC_NOTES',           'QC Notes'),
    ASSIGNED_TO:        resolveField(client, 'ASSIGNED_TO',        'Assigned To'),
    CONTENT_PRODUCTION: resolveField(client, 'CONTENT_PRODUCTION', 'Content Production'),
  }

  // ── Status label mapping ──────────────────────────────────────────────────
  const L = {
    contentRevision:   resolveLabel(client, 'contentRevisionStatus',  'Revision Needed'),
    contentQC:         resolveLabel(client, 'contentQCStatus',        'Final QC Review'),
    contentInProd:     resolveLabel(client, 'contentInProdStatus',    'In Production'),
    contentPreProd:    resolveLabel(client, 'contentPreProdStatus',   'Pre-Production'),
    taskQC:            resolveLabel(client, 'taskQCStatus',           'Pending QC Review'),
    taskRevision:      resolveLabel(client, 'taskRevisionStatus',     'Review Needed'),
  }

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

    async function fetchPage(id) {
      const r = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers });
      if (!r.ok) return null;
      return r.json();
    }

    const getTitle       = p => p?.type === 'title'        ? p.title?.map(t => t.plain_text).join('') : '';
    const getStatus      = p => p?.type === 'status'       ? p.status?.name : null;
    const getDate        = p => p?.type === 'date'         ? p.date?.start  : null;
    const getMultiSelect = p => p?.type === 'multi_select' ? p.multi_select?.map(s => s.name) : [];
    const getRelIds      = p => p?.type === 'relation'     ? (p.relation || []).map(r => r.id) : [];
    const getRollupText  = p => {
      if (!p || p.type !== 'rollup') return null;
      const arr = p.rollup?.array || [];
      if (!arr.length) return null;
      const first = arr[0];
      return first.title?.map(t => t.plain_text).join('') ||
             first.select?.name || first.status?.name || null;
    };

    const now      = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Fetch all three DBs in parallel
    const [contentPages, taskPages, empPages] = await Promise.all([
      queryAll(CONTENT_DB, {
        or: [
          { property: F.CONTENT_STATUS, status: { equals: L.contentRevision } },
          { property: F.CONTENT_STATUS, status: { equals: L.contentQC } },
          { property: F.CONTENT_STATUS, status: { equals: L.contentInProd } },
          { property: F.CONTENT_STATUS, status: { equals: L.contentPreProd } },
        ],
      }),
      queryAll(TASKS_DB, {
        or: [
          { property: F.TASK_STATUS, status: { equals: L.taskQC } },
          { property: F.TASK_STATUS, status: { equals: L.taskRevision } },
        ],
      }),
      queryAll(EMPLOYEE_DB).catch(() => []),
    ]);

    // Build employee name map: id -> first name
    const empNames = {};
    for (const e of empPages) {
      const titleProp = Object.values(e.properties).find(p => p.type === 'title');
      const name = getTitle(titleProp);
      if (name) empNames[e.id] = name.split(' ')[0];
    }
    function resolveNames(ids) {
      return ids.map(id => empNames[id]).filter(Boolean);
    }

    // Batch-resolve campaign + client page names
    const pageIdSet = new Set();
    for (const p of contentPages) {
      getRelIds(p.properties[F.CAMPAIGN]).slice(0, 1).forEach(id => pageIdSet.add(id));
      getRelIds(p.properties[F.CLIENT]).slice(0, 1).forEach(id => pageIdSet.add(id));
    }
    const pageNameCache = {};
    await Promise.all(Array.from(pageIdSet).map(async id => {
      const page = await fetchPage(id).catch(() => null);
      if (!page) return;
      for (const prop of Object.values(page.properties)) {
        if (prop.type === 'title' && prop.title?.length) {
          pageNameCache[id] = prop.title.map(t => t.plain_text).join('');
          break;
        }
      }
    }));

    const contentItems = [];
    const taskItems    = [];

    // Content Production bottlenecks
    for (const page of contentPages) {
      const p        = page.properties;
      const status   = getStatus(p[F.CONTENT_STATUS]);
      const title    = getTitle(p[F.CONTENT_TITLE]) || 'Untitled';
      const deadline = getDate(p[F.CONTENT_DUE]) || getDate(p[F.PUBLISH_DUE]);
      const channel  = getMultiSelect(p[F.CHANNEL]);
      const type     = getMultiSelect(p[F.CONTENT_TYPE]);

      const people   = resolveNames(getRelIds(p[F.ASSIGNED_BY]));
      const clientId = getRelIds(p[F.CLIENT])[0];
      const clientName = clientId ? (pageNameCache[clientId] || null) : null;

      const isOverdue  = deadline && deadline < todayStr;
      const isDueToday = deadline === todayStr;
      const daysOverdue = isOverdue ? Math.floor((now - new Date(deadline)) / 86400000) : 0;

      const reasons = [];
      if (status === L.contentRevision) reasons.push('Revision');
      if (status === L.contentQC)       reasons.push('QC Review');
      if (isOverdue)  reasons.push('Overdue');
      if (isDueToday) reasons.push('Due Today');

      if (reasons.length === 0) continue;

      contentItems.push({ title, status, deadline, daysOverdue, channel, type, people, client: clientName, reasons, url: page.url });
    }

    // Batch-resolve Content Production names for tasks
    const taskContentIds = new Set();
    for (const page of taskPages) {
      getRelIds(page.properties[F.CONTENT_PRODUCTION]).slice(0, 1).forEach(id => taskContentIds.add(id));
    }
    const contentNameCache = {};
    await Promise.all(Array.from(taskContentIds).map(async id => {
      const page = await fetchPage(id).catch(() => null);
      if (!page) return;
      for (const prop of Object.values(page.properties)) {
        if (prop.type === 'title' && prop.title?.length) {
          contentNameCache[id] = prop.title.map(t => t.plain_text).join('');
          break;
        }
      }
    }));

    // Task QC bottlenecks
    for (const page of taskPages) {
      const p       = page.properties;
      const title   = getTitle(p[F.TASK_TITLE]) || 'Untitled Task';
      const status  = getStatus(p[F.TASK_STATUS]);
      const dueDate = getDate(p[F.TASK_DUE]);
      const qcNotes = p[F.QC_NOTES]?.rich_text?.map(t => t.plain_text).join('') || null;
      const people  = resolveNames(getRelIds(p[F.ASSIGNED_TO]));
      const campaign = getRollupText(p[F.CAMPAIGN]) || null;
      const contentId = getRelIds(p[F.CONTENT_PRODUCTION])[0];
      const contentName = contentId ? (contentNameCache[contentId] || null) : null;

      const isOverdue   = dueDate && dueDate < todayStr;
      const isDueToday  = dueDate === todayStr;
      const daysOverdue = isOverdue ? Math.floor((now - new Date(dueDate)) / 86400000) : 0;

      const reasons = [];
      if (status === L.taskQC)       reasons.push('Pending QC');
      if (status === L.taskRevision) reasons.push('Revision');
      if (isOverdue)  reasons.push('Overdue');
      if (isDueToday) reasons.push('Due Today');

      taskItems.push({ title, status, deadline: dueDate, daysOverdue, people, campaign, contentName, qcNotes, reasons, url: page.url });
    }

    const sortFn = (a, b) => {
      const aOver = a.reasons.includes('Overdue') ? 1 : 0;
      const bOver = b.reasons.includes('Overdue') ? 1 : 0;
      if (aOver !== bOver) return bOver - aOver;
      if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return (b.reasons.includes('Due Today') ? 1 : 0) - (a.reasons.includes('Due Today') ? 1 : 0);
    };
    contentItems.sort(sortFn);
    taskItems.sort(sortFn);

    const all = [...contentItems, ...taskItems];
    return res.status(200).json({
      total:        all.length,
      contentCount: contentItems.length,
      taskCount:    taskItems.length,
      overdue:      all.filter(i => i.reasons.includes('Overdue')).length,
      dueToday:     all.filter(i => i.reasons.includes('Due Today')).length,
      contentQC:    contentItems.filter(i => i.reasons.includes('QC Review')).length,
      taskQC:       taskItems.filter(i => i.reasons.includes('Pending QC')).length,
      revisions:    all.filter(i => i.reasons.includes('Revision')).length,
      content: contentItems,
      tasks:   taskItems,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
