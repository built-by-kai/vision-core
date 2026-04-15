// pages/api/webhook_debug.js — bare minimum debug endpoint
export default async function handler(req, res) {
  // Store payload in Notion Activity Log so we can read it
  const payload = JSON.stringify({
    method: req.method,
    query: req.query,
    body: req.body,
    ct: req.headers?.["content-type"],
  }, null, 2)

  try {
    const token = process.env.NOTION_API_KEY
    const ACTIVITY_LOG = "33ffe60097f68196a65dd2988228defc"
    await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: ACTIVITY_LOG },
        properties: {
          "Name": { title: [{ text: { content: `[DEBUG] Button click ${new Date().toISOString().slice(0,19)}` } }] },
        },
        children: [
          {
            object: "block",
            type: "code",
            code: { rich_text: [{ text: { content: payload.slice(0, 2000) } }], language: "json" }
          }
        ]
      }),
    })
  } catch (e) {
    console.warn("[webhook_debug]", e.message)
  }

  return res.status(200).json({ ok: true })
}
