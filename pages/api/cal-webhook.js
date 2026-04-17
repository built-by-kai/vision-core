/**
 * POST /api/cal-webhook
 *
 * Receives Cal.com webhook events for the Discovery Call event type.
 *
 * BOOKING_CREATED:
 *   1. Find Lead in Notion by attendee email
 *   2. Create Meeting entry (Type=Discovery, Status=Scheduled)
 *   3. Update Lead: Discovery Call date, Stage → "Discovery Booked", link Meeting
 *
 * BOOKING_CANCELLED:
 *   1. Find Meeting by Booking UID
 *   2. Update Meeting Status → Cancelled
 *   3. Update Lead Stage → "Incoming" (back to queue)
 *
 * BOOKING_RESCHEDULED:
 *   1. Find Meeting by Booking UID
 *   2. Update Meeting Date to new time
 *   3. Update Lead Discovery Call date
 */

const NOTION_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

const MEETINGS_DB  = "343fe60097f680bd9c32eb0fb527fa5e";
const LEADS_DB     = "340fe60097f6810091cfe204a1c13f5f";
const PEOPLE_DB    = "b0afe60097f68265b93401fbc6f0fec4";

const H = {
  Authorization: `Bearer ${NOTION_KEY}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
};

async function notion(path, method = "GET", body = null) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: H,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

// ─── Finders ────────────────────────────────────────────────────────────────

async function findPersonByEmail(email) {
  const data = await notion("/databases/" + PEOPLE_DB + "/query", "POST", {
    filter: { property: "Email", email: { equals: email } },
    page_size: 1,
  });
  return data.results?.[0] || null;
}

async function findLeadByPersonId(personId) {
  // Find most recent Incoming lead linked to this person
  const data = await notion("/databases/" + LEADS_DB + "/query", "POST", {
    filter: {
      and: [
        { property: "PIC Name", relation: { contains: personId } },
        { property: "Stage",    status:   { equals: "Incoming" } },
      ],
    },
    sorts: [{ property: "Created On", direction: "descending" }],
    page_size: 1,
  });
  return data.results?.[0] || null;
}

async function findMeetingByBookingUID(uid) {
  const data = await notion("/databases/" + MEETINGS_DB + "/query", "POST", {
    filter: { property: "Booking UID", rich_text: { equals: uid } },
    page_size: 1,
  });
  return data.results?.[0] || null;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function handleBookingCreated(payload) {
  const attendee  = payload.attendees?.[0];
  const email     = attendee?.email;
  const name      = attendee?.name || "Unknown";
  const startTime = payload.startTime; // ISO string
  const uid       = payload.uid;
  const meetUrl   = payload.videoCallData?.url || payload.location || "";
  const duration  = payload.eventDuration || 30;

  if (!email) return { ok: false, reason: "no attendee email" };

  // 1. Find person + lead
  const person = await findPersonByEmail(email);
  const personId = person?.id || null;

  const lead = personId ? await findLeadByPersonId(personId) : null;
  const leadId = lead?.id || null;

  // Get company from lead if available
  const companyId = lead?.properties?.Company?.relation?.[0]?.id || null;

  // 2. Create Meeting
  const meetingProps = {
    "Meeting Title": { title: [{ text: { content: `Discovery Call — ${name}` } }] },
    "Type":          { select: { name: "Discovery" } },
    "Status":        { select: { name: "Scheduled" } },
    "date:Date:start":        startTime,
    "date:Date:is_datetime":  1,
    "Booking UID":   { rich_text: [{ text: { content: uid } }] },
    "Duration (min)":{ number: duration },
  };

  if (meetUrl) meetingProps["Meeting URL"] = { url: meetUrl };
  if (leadId)  meetingProps["Lead"]        = { relation: [{ id: leadId }] };
  if (companyId) meetingProps["Company"]   = { relation: [{ id: companyId }] };
  if (personId) meetingProps["Main Attendee"] = { relation: [{ id: personId }] };

  const meeting = await notion("/pages", "POST", {
    parent: { database_id: MEETINGS_DB },
    properties: meetingProps,
  });
  const meetingId = meeting?.id;

  // 3. Update Lead
  if (leadId) {
    const leadUpdate = {
      "Stage": { status: { name: "Discovery Booked" } },
      "date:Discovery Call:start":       startTime,
      "date:Discovery Call:is_datetime": 1,
    };
    if (meetingId) {
      leadUpdate["Meetings"] = { relation: [{ id: meetingId }] };
    }
    await notion("/pages/" + leadId, "PATCH", { properties: leadUpdate });
  }

  return { ok: true, meetingId, leadId };
}

async function handleBookingCancelled(payload) {
  const uid = payload.uid;
  if (!uid) return { ok: false, reason: "no uid" };

  const meeting = await findMeetingByBookingUID(uid);
  if (!meeting) return { ok: false, reason: "meeting not found" };

  // Update meeting status
  await notion("/pages/" + meeting.id, "PATCH", {
    properties: { "Status": { select: { name: "Cancelled" } } },
  });

  // Revert lead stage back to Incoming
  const leadId = meeting.properties?.Lead?.relation?.[0]?.id;
  if (leadId) {
    await notion("/pages/" + leadId, "PATCH", {
      properties: { "Stage": { status: { name: "Incoming" } } },
    });
  }

  return { ok: true };
}

async function handleBookingRescheduled(payload) {
  const uid      = payload.uid;
  const newStart = payload.startTime;
  if (!uid || !newStart) return { ok: false, reason: "missing uid or startTime" };

  const meeting = await findMeetingByBookingUID(uid);
  if (!meeting) return { ok: false, reason: "meeting not found" };

  // Update meeting date
  await notion("/pages/" + meeting.id, "PATCH", {
    properties: {
      "date:Date:start":       newStart,
      "date:Date:is_datetime": 1,
    },
  });

  // Update lead discovery call date
  const leadId = meeting.properties?.Lead?.relation?.[0]?.id;
  if (leadId) {
    await notion("/pages/" + leadId, "PATCH", {
      properties: {
        "date:Discovery Call:start":       newStart,
        "date:Discovery Call:is_datetime": 1,
      },
    });
  }

  return { ok: true };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { triggerEvent, payload } = req.body;

    let result;
    if (triggerEvent === "BOOKING_CREATED") {
      result = await handleBookingCreated(payload);
    } else if (triggerEvent === "BOOKING_CANCELLED") {
      result = await handleBookingCancelled(payload);
    } else if (triggerEvent === "BOOKING_RESCHEDULED") {
      result = await handleBookingRescheduled(payload);
    } else {
      return res.status(200).json({ ok: true, skipped: triggerEvent });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error("cal-webhook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
