// Temporary debug endpoint - captures what Notion's button actually sends
export default async function handler(req, res) {
  console.log("[debug_request]", {
    method: req.method,
    query: req.query,
    body: req.body,
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
    }
  })
  return res.json({
    method: req.method,
    query: req.query,
    body: req.body,
    received: new Date().toISOString(),
  })
}
