// Vercel Serverless Function — Employee Stats
// Queries Tasks DB only (already shared with integration),
// fetches individual employee pages by ID, groups stats per employee.

import { getClientByToken, getNotionToken, resolveDB, resolveField, resolveLabel } from "../../../lib/supabase"


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Token auth: resolves per-client Notion key from Supabase (no env var per client)
  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })
  const NOTION_KEY = getNotionToken(client)
  const TASKS_DB = resolveDB(client, 'TASKS_DB', '3348b289e31a80dc89e1eb7ba5b49b1a')
  const EMPLOYEE_DB = resolveDB(client, 'EMPLOYEE_DB', 'bc5b99b59468498e8a294149d6f03134')

  // ── Field name mapping ────────────────────────────────────────────────────
  const F = {
    TASK_STATUS:     resolveField(client, 'TASK_STATUS',     'Task Status'),
    TASK_DUE:        resolveField(client, 'TASK_DUE',        'Task Due'),
    ACCUMULATED_MINS:resolveField(client, 'ACCUMULATED_MINS','Accumulated Mins'),
    TASK_DONE_ON:    resolveField(client, 'TASK_DONE_ON',    'Task Done On'),
    TASK_STARTED_ON: resolveField(client, 'TASK_STARTED_ON', 'Task Started On'),
    ASSIGNED_TO:     resolveField(client, 'ASSIGNED_TO',     'Assigned To'),
    EMP_NAME:        resolveField(client, 'EMP_NAME',        'Name'),
    EMP_ROLE:        resolveField(client, 'EMP_ROLE',        'Role'),
    EMP_DEPT:        resolveField(client, 'EMP_DEPT',        'Department'),
    EMP_STATUS:      resolveField(client, 'EMP_STATUS',      'Status'),
  }

  // ── Status label mapping ──────────────────────────────────────────────────
  const L = {
    taskDone:       resolveLabel(client, 'taskDoneStatus',       'Done'),
    taskInProgress: resolveLabel(client, 'taskInProgressStatus', 'In progress'),
    taskQC:         resolveLabel(client, 'taskQCStatus',         'Pending QC Review'),
    taskRevision:   resolveLabel(client, 'taskRevisionStatus',   'Review Needed'),
  }

  try {

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    // ── 1. Fetch all tasks (paginate) ──────────────────────────────
    let allTasks = [], cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${TASKS_DB}/query`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`Tasks query failed: ${await r.text()}`);
      const d = await r.json();
      allTasks = allTasks.concat(d.results);
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);

    // ── 2. Try to load all employees from Employee Hub (if shared) ──
    const empMap = {};
    const empIdSet = new Set();

    try {
      const empRes = await fetch(`https://api.notion.com/v1/databases/${EMPLOYEE_DB}/query`, {
        method: 'POST', headers, body: JSON.stringify({ page_size: 100 }),
      });
      if (empRes.ok) {
        const empData = await empRes.json();
        empData.results.forEach(emp => {
          const p = emp.properties;
          empIdSet.add(emp.id);
          empMap[emp.id] = {
            name:   p[F.EMP_NAME]?.title?.map(t => t.plain_text).join('') || 'Unknown',
            role:   p[F.EMP_ROLE]?.select?.name || '',
            dept:   p[F.EMP_DEPT]?.select?.name || '',
            status: p[F.EMP_STATUS]?.select?.name || 'Active',
            email:  p['Email']?.email || '',
            phone:  p['Phone']?.phone_number || '',
          };
        });
      }
    } catch (_) { /* Employee Hub not shared yet — will fall back to task-derived list */ }

    // Also collect any employee IDs found in tasks (catches employees not in hub)
    allTasks.forEach(task => {
      const assigned = task.properties[F.ASSIGNED_TO]?.relation || [];
      assigned.forEach(r => empIdSet.add(r.id));
    });

    // ── 3. Fetch each employee page ────────────────────────────────
    await Promise.all([...empIdSet].map(async empId => {
      try {
        const r = await fetch(`https://api.notion.com/v1/pages/${empId}`, { headers });
        if (!r.ok) {
          empMap[empId] = { name: 'Unknown', role: '', dept: '', status: 'Active', email: '', phone: '' };
          return;
        }
        const p = (await r.json()).properties;
        empMap[empId] = {
          name:   p[F.EMP_NAME]?.title?.map(t => t.plain_text).join('') || 'Unknown',
          role:   p[F.EMP_ROLE]?.select?.name || '',
          dept:   p[F.EMP_DEPT]?.select?.name || '',
          status: p[F.EMP_STATUS]?.select?.name || 'Active',
          email:  p['Email']?.email || '',
          phone:  p['Phone']?.phone_number || '',
          tasks:  [],
        };
      } catch {
        empMap[empId] = { name: 'Unknown', role: '', dept: '', status: 'Active', email: '', phone: '', tasks: [] };
      }
    }));

    // ── 4. Bucket tasks per employee ───────────────────────────────
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Week boundaries (Monday to Sunday)
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon...
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() + mondayOffset);
    const weekStartStr = weekStart.toISOString().slice(0, 10);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const weekEndStr = weekEnd.toISOString().slice(0, 10);

    // Month boundaries
    const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const monthEnd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const emptyStats = () => ({
      done: 0, inProgress: 0, pendingQC: 0, reviewNeeded: 0,
      notStarted: 0, overdue: 0, dueToday: 0, totalMins: 0, total: 0,
    });

    const statsMap = {};
    [...empIdSet].forEach(id => {
      statsMap[id] = {
        all: emptyStats(),
        week: { done: 0, started: 0, total: 0, mins: 0 },
        month: { done: 0, started: 0, total: 0, mins: 0 },
      };
    });

    allTasks.forEach(task => {
      const tp = task.properties;
      const taskStatus = tp[F.TASK_STATUS]?.status?.name || '';
      const dueRaw     = tp[F.TASK_DUE]?.date?.start || null;
      const accMins    = tp[F.ACCUMULATED_MINS]?.number || 0;
      const doneRaw    = tp[F.TASK_DONE_ON]?.date?.start || null;
      const startedRaw = tp[F.TASK_STARTED_ON]?.date?.start || null;
      const assigned   = tp[F.ASSIGNED_TO]?.relation || [];

      const doneDate    = doneRaw ? doneRaw.slice(0, 10) : null;
      const startedDate = startedRaw ? startedRaw.slice(0, 10) : null;

      assigned.forEach(({ id: empId }) => {
        if (!statsMap[empId]) return;
        const s = statsMap[empId].all;
        const w = statsMap[empId].week;
        const m = statsMap[empId].month;

        s.total++;
        s.totalMins += accMins;

        if      (taskStatus === L.taskDone)       s.done++;
        else if (taskStatus === L.taskInProgress) s.inProgress++;
        else if (taskStatus === L.taskQC)         s.pendingQC++;
        else if (taskStatus === L.taskRevision)   s.reviewNeeded++;
        else                                      s.notStarted++;

        if (dueRaw && taskStatus !== 'Done') {
          const due = new Date(dueRaw); due.setHours(0,0,0,0);
          if      (due < today)                      s.overdue++;
          else if (due.getTime() === today.getTime()) s.dueToday++;
        }

        // Weekly stats (tasks done or started this week)
        if (doneDate && doneDate >= weekStartStr && doneDate <= weekEndStr) {
          w.done++;
          w.mins += accMins;
        }
        if (startedDate && startedDate >= weekStartStr && startedDate <= weekEndStr) {
          w.started++;
        }
        // Count tasks due this week as "this week's total"
        if (dueRaw) {
          const dueStr = dueRaw.slice(0, 10);
          if (dueStr >= weekStartStr && dueStr <= weekEndStr) w.total++;
        }

        // Monthly stats
        if (doneDate && doneDate >= monthStart && doneDate <= monthEnd) {
          m.done++;
          m.mins += accMins;
        }
        if (startedDate && startedDate >= monthStart && startedDate <= monthEnd) {
          m.started++;
        }
        if (dueRaw) {
          const dueStr = dueRaw.slice(0, 10);
          if (dueStr >= monthStart && dueStr <= monthEnd) m.total++;
        }
      });
    });

    // ── 5. Build result array ──────────────────────────────────────
    const employees = [...empIdSet].map(id => {
      const s = statsMap[id].all;
      const w = statsMap[id].week;
      const m = statsMap[id].month;
      return {
        id,
        ...empMap[id],
        stats: {
          ...s,
          totalHrs: Math.round((s.totalMins / 60) * 10) / 10,
        },
        week: {
          done: w.done,
          started: w.started,
          due: w.total,
          hrs: Math.round((w.mins / 60) * 10) / 10,
        },
        month: {
          done: m.done,
          started: m.started,
          due: m.total,
          hrs: Math.round((m.mins / 60) * 10) / 10,
        },
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      employees,
      weekLabel: `${weekStartStr} – ${weekEndStr}`,
      monthLabel: `${today.toLocaleString('en', { month: 'long' })} ${today.getFullYear()}`,
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
