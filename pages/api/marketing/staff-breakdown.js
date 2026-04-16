// Vercel Serverless Function — Staff Task Breakdown
// Queries EMPLOYEE_DB for Active staff, then maps Done tasks by type
// (Planning / Shooting / Editing / Posting) with accumulated duration,
// filterable by week / month / all time.

import { getClientByToken, getNotionToken, resolveDB, resolveField, resolveLabel } from "../../../lib/supabase"

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectType(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('planning') || n.includes('plan'))                               return 'planning';
  if (n.includes('shooting') || n.includes('filming') || n.includes('recording')) return 'shooting';
  if (n.includes('editing')  || n.includes('edit'))                               return 'editing';
  if (n.includes('posting')  || n.includes('post'))                               return 'posting';
  return 'other';
}

function fmtDuration(mins) {
  mins = Math.round(Math.abs(mins || 0));
  if (mins === 0) return null;
  if (mins < 60)  return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Normalise UUID: strip hyphens for consistent comparison
function normId(id) {
  return (id || '').replace(/-/g, '');
}

const TYPES = ['planning', 'shooting', 'editing', 'posting', 'other'];

function emptyBreakdown() {
  const b = { total: { done: 0, mins: 0 } };
  for (const t of TYPES) b[t] = { done: 0, mins: 0 };
  return b;
}

function formatBreakdown(b) {
  const result = {
    total: { done: b.total.done, mins: b.total.mins, duration: fmtDuration(b.total.mins) },
  };
  for (const t of TYPES) {
    result[t] = { done: b[t].done, mins: b[t].mins, duration: fmtDuration(b[t].mins) };
  }
  return result;
}

// Paginate through an entire Notion database
async function queryAll(dbId, headers, filter) {
  let results = [], cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`DB query failed (${dbId}): ${await r.text()}`);
    const d = await r.json();
    results = results.concat(d.results);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.query.token || req.headers['x-widget-token'];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const client = await getClientByToken(token);
  if (!client) return res.status(403).json({ error: 'Invalid token' });

  const NOTION_KEY  = getNotionToken(client);
  const TASKS_DB    = resolveDB(client, 'TASKS_DB',    '3348b289e31a80dc89e1eb7ba5b49b1a');
  const EMPLOYEE_DB = resolveDB(client, 'EMPLOYEE_DB', '78f0b17772964c018044a2dfdca6a5e8');

  const F = {
    TASK_STATUS:      resolveField(client, 'TASK_STATUS',       'Task Status'),
    TASK_DONE_ON:     resolveField(client, 'TASK_DONE_ON',      'Task Done On'),
    ACCUMULATED_MINS: resolveField(client, 'ACCUMULATED_MINS',  'Accumulated Mins'),
    ASSIGNED_TO:      resolveField(client, 'ASSIGNED_TO',       'Assigned To'),
    TASK_LIST:        resolveField(client, 'TASK_LIST',         'Task List'),
    CONTENT_PROD:     resolveField(client, 'CONTENT_PRODUCTION','Content Production'),
  };

  const DONE_STATUS = resolveLabel(client, 'taskDoneStatus', 'Done');

  try {
    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    // ── 1. Fetch Active employees from EMPLOYEE_DB ────────────────────────────
    const empPages = await queryAll(EMPLOYEE_DB, headers, {
      property: 'Status',
      select: { equals: 'Active' },
    });

    // Build empMap keyed by normalised ID
    const empMap = {};
    for (const page of empPages) {
      const p   = page.properties;
      const id  = normId(page.id);
      empMap[id] = {
        name:   (p['Name']?.title || []).map(t => t.plain_text).join('') || 'Unknown',
        role:   p['Role']?.select?.name || '',
        status: p['Status']?.select?.name || 'Active',
      };
    }

    const empIds = Object.keys(empMap); // normalised IDs

    // ── 2. Fetch all tasks ────────────────────────────────────────────────────
    const allTasks = await queryAll(TASKS_DB, headers);

    // ── 3. Time boundaries ────────────────────────────────────────────────────
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Mon–Sun week
    const dow = today.getDay();
    const mondayOff = dow === 0 ? -6 : 1 - dow;
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() + mondayOff);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const weekEndStr   = weekEnd.toISOString().slice(0, 10);

    // Calendar month
    const y = today.getFullYear();
    const mo = String(today.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, today.getMonth() + 1, 0).getDate();
    const monthStart = `${y}-${mo}-01`;
    const monthEnd   = `${y}-${mo}-${String(lastDay).padStart(2, '0')}`;

    // ── 4. Initialise stats for every active employee ─────────────────────────
    const statsMap = {};
    for (const id of empIds) {
      statsMap[id] = { all: emptyBreakdown(), week: emptyBreakdown(), month: emptyBreakdown() };
    }

    // ── 5. Bucket tasks ───────────────────────────────────────────────────────
    for (const task of allTasks) {
      const tp     = task.properties;
      const status = tp[F.TASK_STATUS]?.status?.name || '';

      // Only Done tasks linked to content production
      if (status !== DONE_STATUS) continue;
      const contentRel = tp[F.CONTENT_PROD]?.relation || [];
      if (contentRel.length === 0) continue;

      const taskName = (tp[F.TASK_LIST]?.title || []).map(t => t.plain_text).join('');
      const type     = detectType(taskName);
      const doneRaw  = tp[F.TASK_DONE_ON]?.date?.start || null;
      const accMins  = tp[F.ACCUMULATED_MINS]?.number  || 0;
      const doneDate = doneRaw ? doneRaw.slice(0, 10) : null;

      for (const { id: rawId } of tp[F.ASSIGNED_TO]?.relation || []) {
        const empId = normId(rawId);
        if (!statsMap[empId]) continue; // not an active employee we track

        // All time
        statsMap[empId].all.total.done++;
        statsMap[empId].all.total.mins += accMins;
        statsMap[empId].all[type].done++;
        statsMap[empId].all[type].mins += accMins;

        // This week
        if (doneDate && doneDate >= weekStartStr && doneDate <= weekEndStr) {
          statsMap[empId].week.total.done++;
          statsMap[empId].week.total.mins += accMins;
          statsMap[empId].week[type].done++;
          statsMap[empId].week[type].mins += accMins;
        }

        // This month
        if (doneDate && doneDate >= monthStart && doneDate <= monthEnd) {
          statsMap[empId].month.total.done++;
          statsMap[empId].month.total.mins += accMins;
          statsMap[empId].month[type].done++;
          statsMap[empId].month[type].mins += accMins;
        }
      }
    }

    // ── 6. Build result array — ALL active employees, even those with 0 tasks ─
    const employees = empIds
      .filter(id => empMap[id]?.name && empMap[id].name !== 'Unknown')
      .map(id => ({
        id,
        ...empMap[id],
        all:   formatBreakdown(statsMap[id].all),
        week:  formatBreakdown(statsMap[id].week),
        month: formatBreakdown(statsMap[id].month),
      }))
      .sort((a, b) => b.all.total.done - a.all.total.done);

    return res.status(200).json({
      employees,
      weekLabel:  `${weekStartStr} – ${weekEndStr}`,
      monthLabel: `${today.toLocaleString('en', { month: 'long' })} ${today.getFullYear()}`,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
