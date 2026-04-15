// Bare minimum debug endpoint with OPTIONS support
export default function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization")
    return res.status(200).end()
  }
  return res.status(200).json({ ok: true })
}
