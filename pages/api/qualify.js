/**
 * POST /api/qualify
 *
 * Receives pre-qualification form data from /book page.
 * 1. Runs disqualification logic
 * 2. Finds or creates Company in Notion
 * 3. Finds or creates Person in Notion
 * 4. Creates Lead in Notion with all fields
 * 5. Returns { qualified: bool, reason?: string }
 */

const NOTION_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

const LEADS_DB = "340fe60097f6810091cfe204a1c13f5f";
const COMPANIES_DB = "725fe60097f682c09be901fe6ebb6b41";
const PEOPLE_DB = "b0afe60097f68265b93401fbc6f0fec4";

const HEADERS = {
  Authorization: `Bearer ${NOTION_KEY}`,
  "Notion-Version": NOTION_VERSION,
  "Content-Type": "application/json",
};

// ─── Disqualification Logic ─────────────────────────────────────────────────

function checkQualification(form) {
  const { budget, monthlyRevenue } = form;

  if (budget === "Under RM 1500") {
    return { qualified: false, reason: "budget_too_low" };
  }

  if (monthlyRevenue === "Under RM 15K") {
    return { qualified: false, reason: "revenue_too_low" };
  }

  return { qualified: true };
}

// ─── Notion Helpers ──────────────────────────────────────────────────────────

async function notionFetch(path, method = "GET", body = null) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: HEADERS,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function findCompany(name) {
  const data = await notionFetch("/databases/" + COMPANIES_DB + "/query", "POST", {
    filter: {
      property: "Company",
      title: { equals: name },
    },
    page_size: 1,
  });
  return data.results?.[0]?.id || null;
}

async function createCompany(form) {
  const props = {
    Company: { title: [{ text: { content: form.company } }] },
    Status:  { select: { name: "Prospect" } },
  };
  if (form.industry)  props.Industry  = { select: { name: form.industry } };
  if (form.teamSize)  props["Team Size"] = { select: { name: form.teamSize } };
  const data = await notionFetch("/pages", "POST", {
    parent: { database_id: COMPANIES_DB },
    properties: props,
  });
  return data.id || null;
}

async function findPerson(email) {
  const data = await notionFetch("/databases/" + PEOPLE_DB + "/query", "POST", {
    filter: {
      property: "Email",
      email: { equals: email },
    },
    page_size: 1,
  });
  return data.results?.[0]?.id || null;
}

async function createPerson(form, companyId) {
  const props = {
    Name: { title: [{ text: { content: form.name } }] },
    Email: { email: form.email },
    Phone: { phone_number: form.phone },
    Status: { select: { name: "Prospect" } },
  };
  if (companyId) {
    props.Company = { relation: [{ id: companyId }] };
  }
  if (form.role) {
    props.Role = { select: { name: form.role } };
  }
  const data = await notionFetch("/pages", "POST", {
    parent: { database_id: PEOPLE_DB },
    properties: props,
  });
  return data.id || null;
}

async function createLead(form, companyId, personId, qualified) {
  const stage = qualified ? "Incoming" : "Disqualified";

  const props = {
    "Lead Name": { title: [{ text: { content: form.name + " — " + form.company } }] },
    Stage: { status: { name: stage } },
    "Entry Point": { select: { name: "Website Form" } },
  };

  // Relations
  if (companyId) props.Company = { relation: [{ id: companyId }] };
  if (personId) props["PIC Name"] = { relation: [{ id: personId }] };

  // Select fields
  if (form.industry) props.Industry = { select: { name: form.industry } };
  if (form.role) props.Role = { select: { name: form.role } };
  if (form.monthlyRevenue) props["Monthly Revenue Range"] = { select: { name: form.monthlyRevenue } };
  if (form.budget) props["Budget Range"] = { select: { name: form.budget } };
  if (form.osInterest?.length) {
    props["OS Interest"] = { select: { name: form.osInterest[0] } };
  }

  // Source
  if (form.source) {
    props.Source = { multi_select: [{ name: form.source }] };
  }
  // If UTM source exists and source not set, use Ads
  if (!form.source && form.utmSource) {
    props.Source = { multi_select: [{ name: "Ads" }] };
  }

  // Team Size (select)
  if (form.teamSize) props["Team Size"] = { select: { name: form.teamSize } };

  // Text fields
  if (form.situation) props.Situation = { rich_text: [{ text: { content: form.situation } }] };
  if (form.utmSource) props["UTM Source"] = { rich_text: [{ text: { content: form.utmSource } }] };
  if (form.utmMedium) props["UTM Medium"] = { rich_text: [{ text: { content: form.utmMedium } }] };
  if (form.utmCampaign) props["UTM Campaign"] = { rich_text: [{ text: { content: form.utmCampaign } }] };

  // Disqualified reason
  if (!qualified) {
    const reasonMap = {
      budget_too_low: "No Budget",
      revenue_too_low: "Revenue Too Low",
    };
    if (form._reason && reasonMap[form._reason]) {
      props["Disqualified Reason"] = { select: { name: reasonMap[form._reason] } };
    }
  }

  const data = await notionFetch("/pages", "POST", {
    parent: { database_id: LEADS_DB },
    properties: props,
  });
  return data.id || null;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const form = req.body;

    // 1. Run qualification check
    const qualResult = checkQualification(form);
    form._reason = qualResult.reason;

    // 2. Find or create Company
    let companyId = await findCompany(form.company);
    if (!companyId) companyId = await createCompany(form);

    // 3. Find or create Person
    let personId = await findPerson(form.email);
    if (!personId) personId = await createPerson(form, companyId);

    // 4. Create Lead
    await createLead(form, companyId, personId, qualResult.qualified);

    // 5. Return result
    return res.status(200).json({
      qualified: qualResult.qualified,
      reason: qualResult.reason || null,
    });

  } catch (err) {
    console.error("qualify error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
