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

// Safely append an ID to a relation without wiping existing entries
async function appendRelation(pageId, property, newId) {
  const page = await notion("/pages/" + pageId);
  const existing = (page.properties?.[property]?.relation || []).map((r) => ({ id: r.id }));
  if (existing.some((r) => r.id === newId)) return;
  await notion("/pages/" + pageId, "PATCH", {
    properties: { [property]: { relation: [...existing, { id: newId }] } },
  });
}

// ─── Discovery Call Meeting Template ─────────────────────────────────────────
// Mirrors the "Discovery Call" template in the Meeting Templates DB.
// Appended as page body when a new Discovery Call meeting is created.

function rt(text) {
  return [{ type: "text", text: { content: text } }];
}

const DISCOVERY_CALL_TEMPLATE = [
  { type: "heading_2",          heading_2:          { rich_text: rt("Before the Call") } },
  { type: "to_do",              to_do:              { rich_text: rt("Check lead record — review OS Interest, Industry, Team Size, Monthly Revenue, Situation notes"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Check if they came from a referral or cold outreach — adjust tone accordingly"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Have Catalogue open in another tab for module reference"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Set timer for 45 minutes"), checked: false } },
  { type: "divider",            divider:            {} },
  { type: "heading_2",          heading_2:          { rich_text: rt("Phase 1 — Frame Control (5 mins)") } },
  { type: "paragraph",          paragraph:          { rich_text: rt("Open with:") } },
  { type: "quote",              quote:              { rich_text: rt("\u201cThanks for making time. Before we get into anything, let me frame how I usually run these calls \u2014 I\u2019ll spend most of the time understanding how your business runs right now, and only towards the end will I walk you through what we do and whether it\u2019s relevant. Sound good?\u201d") } },
  { type: "paragraph",          paragraph:          { rich_text: rt("End with:") } },
  { type: "quote",              quote:              { rich_text: rt("\u201cDid you come in with something specific in mind, or should I walk through a few areas first?\u201d") } },
  { type: "paragraph",          paragraph:          { rich_text: rt("Track A \u2014 They know what they want \u2192 skip to Phase 3") } },
  { type: "paragraph",          paragraph:          { rich_text: rt("Track B \u2014 They want you to lead \u2192 run Phase 2 in full") } },
  { type: "divider",            divider:            {} },
  { type: "heading_2",          heading_2:          { rich_text: rt("Phase 2 \u2014 Current State Diagnosis (10\u201315 mins)") } },
  { type: "heading_3",          heading_3:          { rich_text: rt("Revenue & Sales") } },
  { type: "to_do",              to_do:              { rich_text: rt("Where are your leads coming from right now?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("How are you currently tracking them?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Roughly how many leads per month?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("What\u2019s your rough conversion rate?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Where do deals tend to drop off?"), checked: false } },
  { type: "heading_3",          heading_3:          { rich_text: rt("Workflow & Operations") } },
  { type: "to_do",              to_do:              { rich_text: rt("Walk me through what happens after a client confirms \u2014 what\u2019s the first thing you do?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Where do things typically slip or slow down?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Is it clear who owns what on each project?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("How are you tracking deadlines right now?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("What causes the most delays?"), checked: false } },
  { type: "heading_3",          heading_3:          { rich_text: rt("Visibility") } },
  { type: "to_do",              to_do:              { rich_text: rt("If I asked you right now what your pipeline is worth \u2014 could you tell me?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Do you know how many active contracts you have running?"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("How do you forecast revenue month to month?"), checked: false } },
  { type: "divider",            divider:            {} },
  { type: "heading_2",          heading_2:          { rich_text: rt("Phase 3 \u2014 Cost of Chaos (5 mins)") } },
  { type: "to_do",              to_do:              { rich_text: rt("\u201cWhat you\u2019re describing is quite common \u2014 especially at your stage.\u201d"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("\u201cIf your volume doubled tomorrow \u2014 could your current setup handle it?\u201d"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("\u201cI\u2019ve seen agencies grow fast but the ops layer can\u2019t keep up.\u201d"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("\u201cThat pressure falls back on you as the founder, right?\u201d"), checked: false } },
  { type: "quote",              quote:              { rich_text: rt("Pause here. Let them respond. Do not fill the silence.") } },
  { type: "divider",            divider:            {} },
  { type: "heading_2",          heading_2:          { rich_text: rt("Phase 4 \u2014 Position the Offer (10 mins)") } },
  { type: "to_do",              to_do:              { rich_text: rt("Recap their pain using their own words \u2014 confirm it back"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Reframe: the issue is not lack of leads, it\u2019s lack of centralised visibility"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Introduce the right OS based on diagnosis:"), checked: false, children: [
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: rt("Revenue OS \u2014 pipeline chaos, invisible deals, payment blind spots") } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: rt("Operations OS \u2014 project slippage, unclear ownership, no process") } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: rt("Business OS \u2014 both combined, flagship recommendation") } },
  ]}},
  { type: "to_do",              to_do:              { rich_text: rt("Name 5 specific modules relevant to how they run"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("\u201cThis is not a template \u2014 it\u2019s mapped to how you actually operate\u201d"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Handle tool objection if raised: validate the tool, challenge the structure inside it"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Clarify Notion workspace requirement \u2014 Free plan not enough, Plus plan needed"), checked: false } },
  { type: "divider",            divider:            {} },
  { type: "heading_2",          heading_2:          { rich_text: rt("Phase 5 \u2014 Close Direction") } },
  { type: "to_do",              to_do:              { rich_text: rt("Check alignment: \u201cDoes this feel like it addresses what you described?\u201d"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Present investment clearly and confidently \u2014 no apologising for price"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Remove risk: \u201cWe scope it to your operation before anything is built\u201d"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Direct close: \u201cAre you ready to move forward and secure your implementation slot?\u201d"), checked: false } },
  { type: "heading_3",          heading_3:          { rich_text: rt("Objection Responses") } },
  { type: "toggle",             toggle:             { rich_text: rt("\u201cWe already use ClickUp / Lark / Trello\u201d"), children: [
    { type: "quote", quote: { rich_text: rt("\u201cThat\u2019s actually good to hear \u2014 it means your team is open to using tools. The question isn\u2019t the tool, it\u2019s the structure inside it. Most teams use ClickUp like a task list, not an operating system. What we build is different.\u201d") } },
  ]}},
  { type: "toggle",             toggle:             { rich_text: rt("\u201cWe\u2019re okay with our current system\u201d"), children: [
    { type: "quote", quote: { rich_text: rt("\u201cIf everything is already visible and structured \u2014 honestly, you may not need me. But based on what you described earlier about [specific pain point], it sounds like there\u2019s at least one area that\u2019s costing you time. Want to zoom in on just that?\u201d") } },
  ]}},
  { type: "toggle",             toggle:             { rich_text: rt("Price objection \u2014 budget"), children: [
    { type: "quote", quote: { rich_text: rt("\u201cUnderstood. We can start with a single OS as the entry point and expand from there. The full install isn\u2019t always the right first step \u2014 what matters is getting the foundation right. Want me to walk you through what a phased approach looks like?\u201d") } },
  ]}},
  { type: "toggle",             toggle:             { rich_text: rt("\u201cWe need to think about it\u201d"), children: [
    { type: "quote", quote: { rich_text: rt("\u201cOf course. What specifically is making you hesitate? I\u2019d rather address that now than have you sit with a question I could have answered.\u201d") } },
  ]}},
  { type: "divider",            divider:            {} },
  { type: "heading_2",          heading_2:          { rich_text: rt("Closing Line") } },
  { type: "quote",              quote:              { rich_text: rt("\u201cThank you for your time. Whether we work together or not \u2014 I hope this gave you some clarity on where the gaps are. If anything changes, you know where to find me.\u201d") } },
  { type: "divider",            divider:            {} },
  { type: "heading_2",          heading_2:          { rich_text: rt("Post-Call Actions") } },
  { type: "to_do",              to_do:              { rich_text: rt("Update Lead Stage in Notion"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Log Outcome on Meeting record"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Set Follow Up date"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Note OS recommendation and modules discussed"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("If qualified \u2192 Create Deal record and link to Lead"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("If sending proposal \u2192 update Deal Stage to Proposal Sent"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("WhatsApp follow-up within 2 hours"), checked: false } },
  { type: "divider",            divider:            {} },
  { type: "heading_2",          heading_2:          { rich_text: rt("AI Transcription Instructions") } },
  { type: "quote",              quote:              { rich_text: rt("Focus areas for AI notes:") } },
  { type: "quote",              quote:              { rich_text: rt("Capture the prospect\u2019s exact words when describing their pain. Flag any specific tools they mentioned. Note any objections raised and how they responded. Capture the OS and modules discussed. Note any budget signals or timeline comments.") } },
  { type: "quote",              quote:              { rich_text: rt("Format output as:") } },
  { type: "quote",              quote:              { rich_text: rt("\u2013 Pain summary (2\u20133 sentences in their words)") } },
  { type: "quote",              quote:              { rich_text: rt("\u2013 Current tools (bullet list)") } },
  { type: "quote",              quote:              { rich_text: rt("\u2013 Objections raised (bullet list)") } },
  { type: "quote",              quote:              { rich_text: rt("\u2013 OS recommendation discussed") } },
  { type: "quote",              quote:              { rich_text: rt("\u2013 Modules mentioned") } },
  { type: "quote",              quote:              { rich_text: rt("\u2013 Budget signal (if any)") } },
  { type: "quote",              quote:              { rich_text: rt("\u2013 Next step agreed") } },
  { type: "quote",              quote:              { rich_text: rt("Generate these tasks as checkboxes:") } },
  { type: "to_do",              to_do:              { rich_text: rt("Update Lead Stage"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Log meeting outcome"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Set follow-up date"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Send WhatsApp follow-up"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Create Deal (if qualified)"), checked: false } },
  { type: "to_do",              to_do:              { rich_text: rt("Draft proposal (if requested)"), checked: false } },
];

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
        { property: "Primary Contact", relation: { contains: personId } },
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
  // Cal.com puts the video link in videoCallData.url; location is a raw string like
  // "integrations:daily" or "Google Meet" — only use it if it looks like a URL
  const rawLocation = payload.location || "";
  const meetUrl = payload.videoCallData?.url
    || (rawLocation.startsWith("http") ? rawLocation : "");
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
    "Meeting Title":  { title: [{ text: { content: `Discovery Call — ${name}` } }] },
    "Type":           { select: { name: "Discovery" } },
    "Status":         { select: { name: "Scheduled" } },
    "Date":           { date: { start: startTime } },
    "Booking UID":    { rich_text: [{ text: { content: uid } }] },
    "Duration (min)": { number: duration },
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

  // 3. Append Discovery Call body template to meeting page
  if (meetingId) {
    await notion("/blocks/" + meetingId + "/children", "PATCH", {
      children: DISCOVERY_CALL_TEMPLATE,
    });
  }

  // 4. Update Lead
  if (leadId) {
    const leadUpdate = {
      "Stage":          { status: { name: "Discovery Booked" } },
      "Discovery Call": { date: { start: startTime } },
    };
    await notion("/pages/" + leadId, "PATCH", { properties: leadUpdate });
  }

  // 5. Stitch reverse relations so Notion shows them without manual sync
  if (meetingId && leadId)    await appendRelation(leadId, "Meetings", meetingId);
  if (meetingId && companyId) await appendRelation(companyId, "Meetings", meetingId);
  if (meetingId && personId)  await appendRelation(personId, "Meetings", meetingId);

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
    properties: { "Date": { date: { start: newStart } } },
  });

  // Update lead discovery call date
  const leadId = meeting.properties?.Lead?.relation?.[0]?.id;
  if (leadId) {
    await notion("/pages/" + leadId, "PATCH", {
      properties: { "Discovery Call": { date: { start: newStart } } },
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
