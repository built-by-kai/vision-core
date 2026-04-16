// Unified Task Action endpoint for Creaitors
// POST body: { action: "start" | "submit_qc" | "approve_qc" | "complete", page_id: "..." }
// Token via ?token= query param or x-widget-token header

import { getClientByToken, getNotionToken, resolveDB } from "../../../lib/supabase"

function formatDuration(minutes) {
  minutes = Math.abs(Math.round(minutes));
  if (minutes < 60) return `${minutes} mins`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (minutes < 10080) {
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  const w = Math.floor(minutes / 10080);
  const d = Math.floor((minutes % 10080) / 1440);
  return d > 0 ? `${w}w ${d}d` : `${w}w`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const token = req.query.token || req.headers['x-widget-token'];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const client = await getClientByToken(token);
  if (!client) return res.status(403).json({ error: 'Invalid token' });

  const NOTION_KEY = getNotionToken(client);
  const TASKS_DB   = resolveDB(client, 'TASKS_DB', '3348b289e31a80dc89e1eb7ba5b49b1a');

  const headers = {
    'Authorization': `Bearer ${NOTION_KEY}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  const body = req.body || {};
  const action = body.action || req.query.action;
  const taskPageId = body.page_id || body.data?.id || body.source?.page_id || req.query.page_id;

  if (!action)     return res.status(400).json({ error: 'Missing action. Use: start | submit_qc | approve_qc | complete' });
  if (!taskPageId) return res.status(400).json({ error: 'Missing page_id in request body.' });

  try {
    const taskRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, { headers });
    if (!taskRes.ok) throw new Error(`Failed to fetch task: ${await taskRes.text()}`);
    const taskPage = await taskRes.json();
    const props = taskPage.properties;

    const taskName    = props['Task List']?.title?.map(t => t.plain_text).join('') || '';
    const now         = new Date().toISOString();

    // ── START TASK ────────────────────────────────────────────────────────────
    if (action === 'start') {
      const currentStatus      = props['Task Status']?.status?.name || '';
      const existingAccMins    = props['Accumulated Mins']?.number || 0;
      const contentRelation    = props['Content Production']?.relation || [];
      const isQcRejection      = currentStatus === 'Review Needed';
      const newAccumulatedMins = isQcRejection ? existingAccMins : 0;

      await patch(taskPageId, {
        'Task Started On':  { date: { start: now } },
        'Task Done On':     { date: null },
        'Duration Display': { rich_text: [] },
        'Task Status':      { status: { name: 'In progress' } },
        'Accumulated Mins': { number: newAccumulatedMins },
      });

      let contentStatusUpdated = false, campaignStatusUpdated = false, campaignSkipped = false;

      if (contentRelation.length > 0) {
        const contentId = contentRelation[0].id;
        try {
          const cr = await patch(contentId, { 'Content Status': { status: { name: 'In Production' } } });
          if (cr.ok) contentStatusUpdated = true;
        } catch (e) { console.error('Content status (non-fatal):', e.message); }

        try {
          const cpRes = await fetch(`https://api.notion.com/v1/pages/${contentId}`, { headers });
          if (cpRes.ok) {
            const cp = await cpRes.json();
            const dealId = cp.properties['Deals']?.relation?.[0]?.id;
            if (dealId) {
              const dRes = await fetch(`https://api.notion.com/v1/pages/${dealId}`, { headers });
              if (dRes.ok) {
                const deal = await dRes.json();
                const campId = deal.properties['Campaign']?.relation?.[0]?.id;
                if (campId) {
                  const campRes = await fetch(`https://api.notion.com/v1/pages/${campId}`, { headers });
                  if (campRes.ok) {
                    const camp = await campRes.json();
                    const campStatus = camp.properties['Campaign Status']?.status?.name || '';
                    if (campStatus !== 'Active') {
                      const cu = await patch(campId, { 'Campaign Status': { status: { name: 'Active' } } });
                      if (cu.ok) campaignStatusUpdated = true;
                    } else { campaignSkipped = true; }
                  }
                }
              }
            }
          }
        } catch (e) { console.error('Campaign cascade (non-fatal):', e.message); }
      }

      await clearActionMessage(taskPageId);
      return res.status(200).json({
        success: true, action,
        message: isQcRejection
          ? `"${taskName}" restarted after QC rejection. Accumulated time preserved (${Math.round(newAccumulatedMins)} mins).`
          : `"${taskName}" started. Timer running.`,
        task: taskName, startedAt: now, accumulatedMins: newAccumulatedMins,
        isQcRejection, contentStatusUpdated, campaignStatusUpdated, campaignSkipped,
      });
    }

    // ── SUBMIT QC ─────────────────────────────────────────────────────────────
    if (action === 'submit_qc') {
      if (/posting/i.test(taskName)) {
        return actionError(taskPageId, 'Content Posting does not need to submit for review. Use Complete Task instead.');
      }

      const startedOnRaw  = props['Task Started On']?.date?.start || null;
      const accMins       = props['Accumulated Mins']?.number || 0;
      const cycleMins     = startedOnRaw ? (new Date(now) - new Date(startedOnRaw)) / 60000 : 0;
      const totalMins     = accMins + cycleMins;
      const durationDisplay = formatDuration(totalMins);

      await patch(taskPageId, {
        'Task Status':      { status: { name: 'Pending QC Review' } },
        'Task Done On':     { date: { start: now } },
        'Accumulated Mins': { number: totalMins },
        'Duration Display': { rich_text: [{ type: 'text', text: { content: durationDisplay } }] },
      });

      await clearActionMessage(taskPageId);
      return res.status(200).json({
        success: true, action,
        message: `"${taskName}" submitted for QC. Total time: ${durationDisplay}.`,
        task: taskName, submittedAt: now,
        currentCycleMins: Math.round(cycleMins), totalMins: Math.round(totalMins), durationDisplay,
      });
    }

    // ── APPROVE QC ────────────────────────────────────────────────────────────
    if (action === 'approve_qc') {
      const currentStatus    = props['Task Status']?.status?.name || '';
      const currentOrder     = props['Order']?.number ?? null;
      const contentLinks     = props['Content Production']?.relation || [];
      const contentId        = contentLinks[0]?.id || null;

      if (currentStatus !== 'Pending QC Review') {
        return actionError(taskPageId, `"${taskName}" is not in Pending QC Review (currently: "${currentStatus}"). Cannot approve.`);
      }

      let nextTask = null;
      if (contentId && currentOrder !== null) {
        try {
          const qr = await fetch(`https://api.notion.com/v1/databases/${TASKS_DB}/query`, {
            method: 'POST', headers,
            body: JSON.stringify({ filter: { property: 'Content Production', relation: { contains: contentId } } }),
          });
          if (qr.ok) {
            const tasks = (await qr.json()).results;
            nextTask = tasks.find(t => t.properties['Order']?.number === currentOrder + 1) || null;
          }
        } catch (e) { console.error('Cascade check (non-fatal):', e.message); }
      }

      const isLastTask   = contentId && currentOrder !== null && nextTask === null;
      const newTaskStatus = isLastTask ? 'Ready for Posting' : 'Done';

      await patch(taskPageId, { 'Task Status': { status: { name: newTaskStatus } } });

      let cascadeResult = null;
      try {
        if (isLastTask && contentId) {
          await patch(contentId, { 'Content Status': { status: { name: 'Ready for Posting' } } });
          cascadeResult = { contentStatus: 'Ready for Posting', lastTask: true };
        } else if (nextTask) {
          const nextName = nextTask.properties['Task List']?.title?.map(t => t.plain_text).join('') || '';
          const nr = await patch(nextTask.id, { 'Task Status': { status: { name: 'Ready to Work' } } });
          if (nr.ok) cascadeResult = { nextTask: nextName, order: currentOrder + 1, status: 'Ready to Work' };
        }
      } catch (e) { console.error('Approve QC cascade (non-fatal):', e.message); }

      await clearActionMessage(taskPageId);
      return res.status(200).json({
        success: true, action,
        message: cascadeResult?.lastTask
          ? `"${taskName}" QC approved — ready for posting.`
          : cascadeResult?.nextTask
            ? `"${taskName}" QC approved → "${cascadeResult.nextTask}" is now Ready to Work.`
            : `"${taskName}" QC approved and marked ${newTaskStatus}.`,
        task: taskName, approvedAt: now, newStatus: newTaskStatus,
        ...(cascadeResult ? { cascade: cascadeResult } : {}),
      });
    }

    // ── COMPLETE TASK ─────────────────────────────────────────────────────────
    if (action === 'complete') {
      const isPostingTask = /posting/i.test(taskName);
      if (isPostingTask) {
        const postingLink = props['Posting Link']?.url || null;
        if (!postingLink?.trim()) {
          return actionError(taskPageId, `"${taskName}" cannot be completed yet — the content hasn't been posted. Paste the live posting link first, then mark as done.`);
        }
      }

      const startedOnRaw     = props['Task Started On']?.date?.start || null;
      const doneOnRaw        = props['Task Done On']?.date?.start || null;
      const accMins          = props['Accumulated Mins']?.number || 0;
      const existingDisplay  = props['Duration Display']?.rich_text?.map(t => t.plain_text).join('') || '';
      const contentLinks     = props['Content Production']?.relation || [];
      const currentOrder     = props['Order']?.number ?? null;

      let totalMins = accMins;
      let durationDisplay = existingDisplay;
      const timerFinalized = !!doneOnRaw && !!existingDisplay;
      if (!timerFinalized && startedOnRaw) {
        const cycleMins = (new Date(now) - new Date(startedOnRaw)) / 60000;
        totalMins += cycleMins;
        durationDisplay = totalMins > 0 ? formatDuration(totalMins) : '';
      }

      await patch(taskPageId, {
        'Task Status':      { status: { name: 'Done' } },
        'Task Done On':     { date: { start: now } },
        'Accumulated Mins': { number: totalMins },
        'Duration Display': { rich_text: durationDisplay ? [{ type: 'text', text: { content: durationDisplay } }] : [] },
      });

      if (!contentLinks.length || currentOrder === null) {
        await clearActionMessage(taskPageId);
        return res.status(200).json({
          success: true, action,
          message: `"${taskName}" completed (${durationDisplay || 'no timer'}). No cascade needed.`,
          task: taskName, doneAt: now, durationDisplay,
        });
      }

      const contentId = contentLinks[0].id;
      const qr = await fetch(`https://api.notion.com/v1/databases/${TASKS_DB}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ filter: { property: 'Content Production', relation: { contains: contentId } } }),
      });
      if (!qr.ok) throw new Error(`Failed to query tasks: ${await qr.text()}`);
      const allTasks = (await qr.json()).results;
      const nextTask = allTasks.find(t => t.properties['Order']?.number === currentOrder + 1);

      if (!nextTask) {
        try { await patch(contentId, { 'Content Status': { status: { name: 'Done' } } }); } catch (e) { /* non-fatal */ }
        await clearActionMessage(taskPageId);
        return res.status(200).json({
          success: true, action,
          message: `"${taskName}" completed — all tasks done. Content marked Done.`,
          task: taskName, doneAt: now, durationDisplay, contentStatus: 'Done',
        });
      }

      const nextTaskName = nextTask.properties['Task List']?.title?.map(t => t.plain_text).join('') || '';
      await patch(nextTask.id, { 'Task Status': { status: { name: 'Ready to Work' } } });

      await clearActionMessage(taskPageId);
      return res.status(200).json({
        success: true, action,
        message: `"${taskName}" completed (${durationDisplay || 'no timer'}) → "${nextTaskName}" is now Ready to Work.`,
        currentTask: { name: taskName, order: currentOrder, doneAt: now, durationDisplay },
        nextTask: { name: nextTaskName, order: currentOrder + 1, status: 'Ready to Work' },
      });
    }

    return res.status(400).json({ error: `Unknown action "${action}". Use: start | submit_qc | approve_qc | complete` });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function patch(pageId, properties) {
    return fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ properties }),
    });
  }

  // Write error to Action Message field and return 200 (Notion shows success, user sees message on page)
  async function actionError(pageId, message) {
    try {
      await patch(pageId, {
        'Action Message': { rich_text: [{ type: 'text', text: { content: message } }] },
      });
    } catch (e) { console.error('actionError write failed:', e.message); }
    return res.status(200).json({ success: false, message });
  }

  // Clear Action Message on successful action so it doesn't linger
  async function clearActionMessage(pageId) {
    try {
      await patch(pageId, { 'Action Message': { rich_text: [] } });
    } catch (e) { /* non-fatal */ }
  }
}
