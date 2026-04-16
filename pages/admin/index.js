import { useState, useEffect } from "react"
import Head from "next/head"

const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_KEY || "opxio-admin-2026"

const DB_GROUPS = {
  "Revenue OS":    ["LEADS","DEALS","QUOTATIONS","PROPOSALS","INVOICE","FINANCE"],
  "Operations OS": ["PROJECTS","PHASES","TASKS","MEETINGS","RETAINERS","SOPS"],
}

const WIDGETS = [
  { url: "/revenue/crm",         label: "CRM & Pipeline",   dbs: ["LEADS","DEALS"],              os: "revenue",    tier: "base" },
  { url: "/revenue/overview",    label: "Revenue Overview", dbs: ["QUOTATIONS","INVOICE"],        os: "revenue",    tier: "base" },
  { url: "/revenue/deals",       label: "Deals Board",      dbs: ["DEALS","QUOTATIONS","PROPOSALS"], os: "revenue", tier: "base" },
  { url: "/revenue/leads",       label: "Leads Funnel",     dbs: ["LEADS"],                      os: "revenue",    tier: "base" },
  { url: "/revenue/billing",     label: "Billing",          dbs: ["INVOICE"],                    os: "revenue",    tier: "base" },
  { url: "/revenue/visitors",    label: "Visitor Insights", dbs: ["LEADS"],                      os: "revenue",    tier: "addon" },
  { url: "/revenue/topproducts", label: "Top Products",     dbs: ["QUOTATIONS"],                 os: "revenue",    tier: "addon" },
  { url: "/revenue/schedule",    label: "Schedule",         dbs: ["MEETINGS"],                   os: "revenue",    tier: "addon" },
  { url: "/revenue/finance",     label: "Finance Snapshot", dbs: ["FINANCE"],                    os: "revenue",    tier: "addon" },
  { url: "/operations/projects", label: "Projects",         dbs: ["PROJECTS","PHASES"],          os: "operations", tier: "base" },
]

const OS_OPTIONS = [
  { value: "revenue",      label: "Revenue OS",      color: "#4ade80" },
  { value: "operations",   label: "Operations OS",   color: "#60a5fa" },
  { value: "business",     label: "Business OS",     color: "#a78bfa" },
  { value: "marketing",    label: "Marketing OS",    color: "#f472b6" },
  { value: "agency",       label: "Agency OS",       color: "#60a5fa" },
  { value: "team",         label: "Team OS",         color: "#fbbf24" },
  { value: "retention",    label: "Retention OS",    color: "#a16207" },
  { value: "intelligence", label: "Intelligence OS", color: "#f87171" },
  { value: "micro",        label: "Micro Install",   color: "#94a3b8" },
]

const TABS = ["Overview", "Notion & DBs", "Stages", "Widgets", "Access"]

const EMPTY_CLIENT = {
  client_name: "", slug: "", os_type: [], notion_token: "", notion_workspace_id: "", status: "active",
  databases: {},
  field_map: { STAGE_FIELD: "", STATUS_FIELD: "", PACKAGE_FIELD: "", TYPE_FIELD: "", INVOICE_TYPE_FIELD: "" },
  labels: { stages: "", activeStages: "", dealAll: "", dealPotential: "", dealWon: "", dealWonLabel: "", dealDeliveredLabel: "" },
  monthly_fee: 0, next_renewal: "", custom_widgets: [], installed_os: {},
}

// ── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: "#111113", surface: "#18181b", surface2: "#1f1f23", surface3: "#27272c",
  border: "rgba(255,255,255,.07)", border2: "rgba(255,255,255,.04)",
  lime: "#AAFF00", limeDim: "rgba(170,255,0,.1)", limeBorder: "rgba(170,255,0,.18)",
  text: "#f4f4f5", textMid: "rgba(244,244,245,.5)", textDim: "rgba(244,244,245,.25)",
  red: "#f87171", redDim: "rgba(248,113,113,.1)", redBorder: "rgba(248,113,113,.2)",
  amber: "#fbbf24", amberDim: "rgba(251,191,36,.1)",
}

function api(path, opts = {}) {
  const key = typeof window !== "undefined" ? (localStorage.getItem("opxio_admin_key") || "") : ""
  const sep = path.includes("?") ? "&" : "?"
  return fetch(`/api/admin/clients${path}${sep}adminKey=${key}`, {
    headers: { "Content-Type": "application/json" }, ...opts,
  }).then(r => r.json())
}

function splitCSV(str) { return str?.trim() ? str.split(",").map(s => s.trim()).filter(Boolean) : undefined }

function clientFromForm(c) {
  const labels = {}
  const ls  = splitCSV(c.labels?.stages);          if (ls)  labels.stages              = ls
  const las = splitCSV(c.labels?.activeStages);     if (las) labels.activeStages        = las
  const da  = splitCSV(c.labels?.dealAll);          if (da)  labels.dealAllStages       = da
  const dp  = splitCSV(c.labels?.dealPotential);    if (dp)  labels.dealPotentialStages = dp
  const dw  = splitCSV(c.labels?.dealWon);          if (dw)  labels.dealWonStages       = dw
  if (c.labels?.dealWonLabel?.trim())        labels.dealWonLabel       = c.labels.dealWonLabel.trim()
  if (c.labels?.dealDeliveredLabel?.trim())  labels.dealDeliveredLabel = c.labels.dealDeliveredLabel.trim()

  return {
    client_name:         c.client_name,
    slug:                c.slug,
    os_type:             c.os_type || [],
    notion_token:        c.notion_token || "",
    notion_workspace_id: c.notion_workspace_id || null,
    status:              c.status,
    databases:           Object.fromEntries(Object.entries(c.databases || {}).filter(([, v]) => v?.trim())),
    field_map:           Object.fromEntries(["STAGE_FIELD","STATUS_FIELD","PACKAGE_FIELD","TYPE_FIELD","INVOICE_TYPE_FIELD"].filter(k => c.field_map?.[k]?.trim()).map(k => [k, c.field_map[k].trim()])),
    labels,
    monthly_fee:         Number(c.monthly_fee) || 0,
    next_renewal:        c.next_renewal || null,
    custom_widgets:      c.custom_widgets || [],
    installed_os:        c.installed_os || {},
  }
}

function formFromClient(c) {
  return {
    client_name:         c.client_name,
    slug:                c.slug,
    os_type:             c.os_type || [],
    notion_token:        c.notion_token || "",
    notion_workspace_id: c.notion_workspace_id || "",
    status:              c.status || "active",
    databases:           { ...(c.databases || {}) },
    field_map: {
      STAGE_FIELD:        c.field_map?.STAGE_FIELD        || "",
      STATUS_FIELD:       c.field_map?.STATUS_FIELD       || "",
      PACKAGE_FIELD:      c.field_map?.PACKAGE_FIELD      || "",
      TYPE_FIELD:         c.field_map?.TYPE_FIELD         || "",
      INVOICE_TYPE_FIELD: c.field_map?.INVOICE_TYPE_FIELD || "",
    },
    labels: {
      stages:             (c.labels?.stages || []).join(", "),
      activeStages:       (c.labels?.activeStages || []).join(", "),
      dealAll:            (c.labels?.dealAllStages || []).join(", "),
      dealPotential:      (c.labels?.dealPotentialStages || []).join(", "),
      dealWon:            (c.labels?.dealWonStages || []).join(", "),
      dealWonLabel:       c.labels?.dealWonLabel       || "",
      dealDeliveredLabel: c.labels?.dealDeliveredLabel || "",
    },
    monthly_fee:    c.monthly_fee || 0,
    next_renewal:   c.next_renewal ? c.next_renewal.slice(0, 10) : "",
    custom_widgets: c.custom_widgets || [],
    installed_os:   c.installed_os || {},
    access_token:   c.access_token,
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 5 }}>
        <label style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.textDim }}>{label}</label>
        {hint && <span style={{ fontSize: 10, color: "rgba(244,244,245,.18)", fontWeight: 400 }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function Input({ value, onChange, placeholder, type = "text", disabled }) {
  return (
    <input type={type} value={value ?? ""} onChange={onChange} placeholder={placeholder} disabled={disabled}
      style={{ width: "100%", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 8, color: disabled ? C.textDim : C.text, fontFamily: "'Satoshi',sans-serif", fontSize: 13, padding: "8px 11px", outline: "none", boxSizing: "border-box", cursor: disabled ? "not-allowed" : "auto" }} />
  )
}

function Select({ value, onChange, children }) {
  return (
    <select value={value} onChange={onChange}
      style={{ width: "100%", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontFamily: "'Satoshi',sans-serif", fontSize: 13, padding: "8px 11px", outline: "none", cursor: "pointer" }}>
      {children}
    </select>
  )
}

function SectionHead({ children }) {
  return <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".1em", color: "rgba(170,255,0,.55)", marginBottom: 12, marginTop: 4 }}>{children}</div>
}

function Grid({ cols = 2, children }) {
  return <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>{children}</div>
}

function StatusBadge({ status }) {
  const col = status === "active" ? C.lime : status === "paused" ? C.amber : C.red
  const bg  = status === "active" ? C.limeDim : status === "paused" ? C.amberDim : C.redDim
  return <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: bg, color: col, border: `1px solid ${col}22`, textTransform: "uppercase", letterSpacing: ".06em" }}>{status}</span>
}

function OsTag({ value }) {
  const opt = OS_OPTIONS.find(o => o.value === value)
  const col = opt?.color || "#94a3b8"
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 5, background: col + "15", color: col, border: `1px solid ${col}30` }}>
      {opt?.label || value}
    </span>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const [authed,   setAuthed]   = useState(false)
  const [keyInput, setKeyInput] = useState("")
  const [clients,  setClients]  = useState([])
  const [selected, setSelected] = useState(null)   // slug or "__new__"
  const [form,     setForm]     = useState(EMPTY_CLIENT)
  const [tab,      setTab]      = useState("Overview")
  const [saving,   setSaving]   = useState(false)
  const [toast,    setToast]    = useState(null)
  const [delSlug,  setDelSlug]  = useState(null)
  const [urlModal, setUrlModal] = useState(null)
  const [search,   setSearch]   = useState("")

  const showToast = (msg, type = "ok") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }
  const copy = txt => { navigator.clipboard?.writeText(txt); showToast("Copied to clipboard") }

  async function loadClients() {
    const data = await api("")
    if (Array.isArray(data)) setClients(data)
  }

  useEffect(() => { if (authed) loadClients() }, [authed])

  function openNew()  { setSelected("__new__"); setForm({ ...EMPTY_CLIENT }); setTab("Overview") }
  function openEdit(c){ setSelected(c.slug);    setForm(formFromClient(c));   setTab("Overview") }

  const setDB  = (k, v) => setForm(f => ({ ...f, databases: { ...f.databases, [k]: v } }))
  const setFM  = (k, v) => setForm(f => ({ ...f, field_map: { ...f.field_map, [k]: v } }))
  const setLbl = (k, v) => setForm(f => ({ ...f, labels:    { ...f.labels,    [k]: v } }))
  const toggleOS  = os  => setForm(f => ({ ...f, os_type:       f.os_type.includes(os)  ? f.os_type.filter(x => x !== os)  : [...f.os_type,  os]  }))
  const toggleW   = url => setForm(f => ({ ...f, custom_widgets: f.custom_widgets.includes(url) ? f.custom_widgets.filter(u => u !== url) : [...f.custom_widgets, url] }))

  async function regenToken() {
    const tok = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2,"0")).join("")
    const res = await api(`?slug=${selected}`, { method: "PUT", body: JSON.stringify({ access_token: tok }) })
    if (res.error) { showToast("Error: " + res.error, "err"); return }
    setForm(f => ({ ...f, access_token: tok }))
    await loadClients()
    showToast("Token regenerated")
  }

  async function save() {
    setSaving(true)
    try {
      const payload = clientFromForm(form)
      if (selected === "__new__") {
        const res = await api("", { method: "POST", body: JSON.stringify(payload) })
        if (res.error) { showToast("Error: " + res.error, "err"); return }
        showToast("Client created ✓")
        setSelected(res.slug)
        setForm(formFromClient(res))
      } else {
        const res = await api(`?slug=${selected}`, { method: "PUT", body: JSON.stringify(payload) })
        if (res.error) { showToast("Error: " + res.error, "err"); return }
        showToast("Saved ✓")
      }
      await loadClients()
    } finally { setSaving(false) }
  }

  async function deleteClient(slug) {
    const res = await api(`?slug=${slug}`, { method: "DELETE" })
    if (res.error) { showToast("Error: " + res.error, "err"); return }
    showToast("Client deleted")
    setDelSlug(null); setSelected(null)
    await loadClients()
  }

  function login() {
    if (!keyInput.trim()) return
    localStorage.setItem("opxio_admin_key", keyInput.trim())
    setAuthed(true)
  }

  const filteredClients = clients.filter(c =>
    !search || c.client_name.toLowerCase().includes(search.toLowerCase()) || c.slug.toLowerCase().includes(search.toLowerCase())
  )

  const urlClient = urlModal ? clients.find(c => c.slug === urlModal) : null
  const renewalSoon = c => c.next_renewal && (new Date(c.next_renewal) - new Date()) < 14 * 86400000

  // ── Login ──────────────────────────────────────────────────────────────────
  if (!authed) return (
    <>
      <Head><title>Opxio Admin</title><link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet"/></Head>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: C.bg }}>
        <div style={{ background: C.surface, borderRadius: 16, padding: "40px 36px", width: 360, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.lime, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 8 }}>OPXIO</div>
          <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: "-.05em", marginBottom: 6, color: C.text }}>Admin Panel</div>
          <div style={{ fontSize: 13, color: C.textMid, marginBottom: 28 }}>Client configuration & management</div>
          <input type="password" value={keyInput} onChange={e => setKeyInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && login()}
            placeholder="Admin key"
            style={{ width: "100%", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 9, color: C.text, fontFamily: "'Satoshi',sans-serif", fontSize: 14, padding: "10px 14px", outline: "none", boxSizing: "border-box", marginBottom: 12 }} />
          <button onClick={login}
            style={{ width: "100%", background: C.lime, color: "#111", fontWeight: 900, fontSize: 14, padding: "11px 0", borderRadius: 9, border: "none", cursor: "pointer" }}>
            Enter
          </button>
        </div>
      </div>
    </>
  )

  // ── App shell ──────────────────────────────────────────────────────────────
  return (
    <>
      <Head><title>Opxio Admin</title><link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet"/></Head>

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: toast.type === "err" ? C.red : C.lime, color: toast.type === "err" ? "#fff" : "#111", fontWeight: 900, fontSize: 13, padding: "10px 20px", borderRadius: 10, zIndex: 999, pointerEvents: "none", boxShadow: "0 4px 24px rgba(0,0,0,.4)" }}>
          {toast.msg}
        </div>
      )}

      {/* Delete confirm */}
      {delSlug && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: C.surface, borderRadius: 16, padding: 32, width: 380, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 17, fontWeight: 900, marginBottom: 8, color: C.text }}>Delete client?</div>
            <div style={{ fontSize: 13, color: C.textMid, marginBottom: 24 }}>
              This permanently removes <strong style={{ color: C.text }}>{delSlug}</strong> from Supabase and invalidates their token. Cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => deleteClient(delSlug)} style={{ background: C.red, color: "#fff", fontWeight: 700, fontSize: 13, padding: "9px 20px", borderRadius: 8, border: "none", cursor: "pointer" }}>Delete</button>
              <button onClick={() => setDelSlug(null)} style={{ background: C.surface3, color: C.textMid, fontWeight: 700, fontSize: 13, padding: "9px 20px", borderRadius: 8, border: `1px solid ${C.border}`, cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Widget URL modal */}
      {urlModal && urlClient && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setUrlModal(null)}>
          <div style={{ background: C.surface, borderRadius: 16, padding: 28, width: 700, maxHeight: "85vh", overflowY: "auto", border: `1px solid ${C.border}` }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 4, color: C.text }}>Widget URLs — {urlClient.client_name}</div>
            <div style={{ fontSize: 11, color: C.textDim, marginBottom: 20 }}>Share these with your client to embed into their Notion.</div>
            {WIDGETS.map(w => {
              const enabled = (urlClient.custom_widgets || []).includes(w.url)
              const missing = w.dbs.filter(db => !urlClient.databases?.[db])
              const url = `https://dashboard.opxio.io${w.url}?token=${urlClient.access_token}`
              return (
                <div key={w.url} style={{ display: "flex", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${C.border2}`, opacity: enabled ? 1 : .35 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{w.label}</span>
                      {enabled
                        ? <span style={{ fontSize: 9, fontWeight: 700, background: C.limeDim, color: C.lime, border: `1px solid ${C.limeBorder}`, padding: "2px 7px", borderRadius: 4 }}>ENABLED</span>
                        : <span style={{ fontSize: 9, fontWeight: 700, background: C.redDim, color: C.red, border: `1px solid ${C.redBorder}`, padding: "2px 7px", borderRadius: 4 }}>DISABLED</span>}
                      <span style={{ fontSize: 9, fontWeight: 700, background: w.tier === "base" ? C.limeDim : C.amberDim, color: w.tier === "base" ? C.lime : C.amber, padding: "2px 7px", borderRadius: 4 }}>{w.tier.toUpperCase()}</span>
                      {missing.length > 0 && enabled && <span style={{ fontSize: 9, color: C.red }}>Missing: {missing.join(", ")}</span>}
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: enabled ? C.lime : C.textDim, wordBreak: "break-all" }}>{url}</div>
                  </div>
                  <button onClick={() => copy(url)} style={{ background: C.limeDim, color: C.lime, border: `1px solid ${C.limeBorder}`, borderRadius: 6, fontSize: 10, fontWeight: 700, padding: "5px 12px", cursor: "pointer", marginLeft: 16, flexShrink: 0, whiteSpace: "nowrap" }}>Copy</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Satoshi',-apple-system,sans-serif", display: "flex", flexDirection: "column" }}>

        {/* Topbar */}
        <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 24px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 900, letterSpacing: ".1em", color: C.lime }}>OPXIO</span>
            <span style={{ fontSize: 12, color: C.textDim, fontWeight: 500 }}>Admin</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span style={{ fontSize: 11, color: C.textDim }}>{clients.length} clients · {clients.filter(c => c.status === "active").length} active</span>
            <button onClick={() => { localStorage.removeItem("opxio_admin_key"); setAuthed(false) }}
              style={{ fontSize: 11, color: C.textDim, background: "none", border: "none", cursor: "pointer", padding: 0 }}>Sign out</button>
          </div>
        </div>

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

          {/* Sidebar */}
          <div style={{ width: 260, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients…"
                style={{ width: "100%", background: C.surface3, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, fontFamily: "'Satoshi',sans-serif", fontSize: 12, padding: "7px 10px", outline: "none", boxSizing: "border-box" }} />
            </div>
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={openNew}
                style={{ background: C.lime, color: "#111", fontSize: 11, fontWeight: 900, padding: "5px 14px", borderRadius: 7, border: "none", cursor: "pointer" }}>
                + New Client
              </button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {filteredClients.length === 0 && (
                <div style={{ padding: "20px 16px", fontSize: 12, color: C.textDim, textAlign: "center" }}>No clients found</div>
              )}
              {filteredClients.map(c => (
                <div key={c.slug} onClick={() => openEdit(c)}
                  style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border2}`, cursor: "pointer", background: selected === c.slug ? "rgba(170,255,0,.05)" : "transparent", borderLeft: selected === c.slug ? `2px solid ${C.lime}` : "2px solid transparent" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.client_name}</span>
                    <StatusBadge status={c.status} />
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                    {(c.os_type || []).map(os => <OsTag key={os} value={os} />)}
                  </div>
                  <div style={{ fontSize: 10, color: C.textDim, display: "flex", gap: 10 }}>
                    <span>{c.slug}</span>
                    {c.monthly_fee > 0 && <span>RM {c.monthly_fee}/mo</span>}
                    {renewalSoon(c) && <span style={{ color: C.amber }}>⚠ renews soon</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Main panel */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {!selected ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 32, opacity: .15 }}>⚙</div>
                <div style={{ fontSize: 14, color: C.textDim }}>Select a client or create a new one</div>
              </div>
            ) : (
              <div>
                {/* Form header */}
                <div style={{ padding: "20px 28px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
                    <div>
                      <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: "-.04em", marginBottom: 4 }}>
                        {selected === "__new__" ? "New Client" : form.client_name || "Unnamed"}
                      </div>
                      {selected !== "__new__" && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {(form.os_type || []).map(os => <OsTag key={os} value={os} />)}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {selected !== "__new__" && (
                        <>
                          <button onClick={() => setUrlModal(selected)}
                            style={{ background: C.limeDim, color: C.lime, border: `1px solid ${C.limeBorder}`, fontWeight: 700, fontSize: 12, padding: "7px 14px", borderRadius: 8, cursor: "pointer" }}>
                            Widget URLs
                          </button>
                          <button onClick={() => setDelSlug(selected)}
                            style={{ background: C.redDim, color: C.red, border: `1px solid ${C.redBorder}`, fontWeight: 700, fontSize: 12, padding: "7px 14px", borderRadius: 8, cursor: "pointer" }}>
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Tabs */}
                  <div style={{ display: "flex", gap: 2 }}>
                    {TABS.map(t => (
                      <button key={t} onClick={() => setTab(t)}
                        style={{ fontSize: 12, fontWeight: 700, padding: "7px 14px", border: "none", cursor: "pointer", background: "none", color: tab === t ? C.lime : C.textDim, borderBottom: tab === t ? `2px solid ${C.lime}` : "2px solid transparent", marginBottom: -1 }}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tab content */}
                <div style={{ padding: "24px 28px", maxWidth: 680 }}>

                  {/* ── Overview ── */}
                  {tab === "Overview" && (
                    <div>
                      <SectionHead>Identity</SectionHead>
                      <Grid cols={2}>
                        <Field label="Client Name">
                          <Input value={form.client_name} onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))} placeholder="Creaitors" />
                        </Field>
                        <Field label="Slug" hint="URL-safe, cannot change after creation">
                          <Input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") }))} placeholder="creaitors" disabled={selected !== "__new__"} />
                        </Field>
                      </Grid>
                      <Grid cols={3}>
                        <Field label="Status">
                          <Select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                            <option value="inactive">Inactive</option>
                          </Select>
                        </Field>
                        <Field label="Monthly Fee (RM)">
                          <Input type="number" value={form.monthly_fee} onChange={e => setForm(f => ({ ...f, monthly_fee: e.target.value }))} placeholder="0" />
                        </Field>
                        <Field label="Next Renewal">
                          <Input type="date" value={form.next_renewal} onChange={e => setForm(f => ({ ...f, next_renewal: e.target.value }))} />
                        </Field>
                      </Grid>

                      <SectionHead style={{ marginTop: 20 }}>OS Type</SectionHead>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
                        {OS_OPTIONS.map(opt => {
                          const active = form.os_type.includes(opt.value)
                          return (
                            <button key={opt.value} onClick={() => toggleOS(opt.value)}
                              style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", border: `1px solid ${active ? opt.color + "50" : C.border}`, background: active ? opt.color + "18" : C.surface3, color: active ? opt.color : C.textDim, transition: "all .15s" }}>
                              {opt.label}
                            </button>
                          )
                        })}
                      </div>

                      <SectionHead>Field Mappings</SectionHead>
                      <div style={{ background: C.surface, borderRadius: 10, padding: "14px 16px", border: `1px solid ${C.border}`, marginBottom: 4 }}>
                        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 14 }}>Only fill in if the client uses different field names in their Notion databases. Leave blank to use defaults.</div>
                        <Grid cols={2}>
                          <Field label="Stage Field" hint="default: Stage">
                            <Input value={form.field_map.STAGE_FIELD} onChange={e => setFM("STAGE_FIELD", e.target.value)} placeholder="Stage" />
                          </Field>
                          <Field label="Status Field" hint="default: Status">
                            <Input value={form.field_map.STATUS_FIELD} onChange={e => setFM("STATUS_FIELD", e.target.value)} placeholder="Status" />
                          </Field>
                          <Field label="Package Field" hint="default: Package Type">
                            <Input value={form.field_map.PACKAGE_FIELD} onChange={e => setFM("PACKAGE_FIELD", e.target.value)} placeholder="Package Type" />
                          </Field>
                          <Field label="Meeting Type Field" hint="default: Type">
                            <Input value={form.field_map.TYPE_FIELD} onChange={e => setFM("TYPE_FIELD", e.target.value)} placeholder="Type" />
                          </Field>
                          <Field label="Invoice Type Field" hint="default: Invoice Type">
                            <Input value={form.field_map.INVOICE_TYPE_FIELD} onChange={e => setFM("INVOICE_TYPE_FIELD", e.target.value)} placeholder="Invoice Type" />
                          </Field>
                        </Grid>
                      </div>
                    </div>
                  )}

                  {/* ── Notion & DBs ── */}
                  {tab === "Notion & DBs" && (
                    <div>
                      <SectionHead>Notion Integration</SectionHead>
                      <div style={{ background: C.surface, borderRadius: 10, padding: "14px 16px", border: `1px solid ${C.border}`, marginBottom: 20 }}>
                        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 14 }}>Use the client's own integration token (preferred). Leave blank to fall back to the Opxio shared key.</div>
                        <Grid cols={2}>
                          <Field label="Notion API Token">
                            <Input value={form.notion_token} onChange={e => setForm(f => ({ ...f, notion_token: e.target.value }))} placeholder="ntn_..." />
                          </Field>
                          <Field label="Workspace ID" hint="optional">
                            <Input value={form.notion_workspace_id} onChange={e => setForm(f => ({ ...f, notion_workspace_id: e.target.value }))} placeholder="workspace uuid" />
                          </Field>
                        </Grid>
                      </div>

                      {Object.entries(DB_GROUPS).map(([group, keys]) => (
                        <div key={group} style={{ marginBottom: 20 }}>
                          <SectionHead>{group} — Database IDs</SectionHead>
                          <div style={{ background: C.surface, borderRadius: 10, padding: "14px 16px", border: `1px solid ${C.border}` }}>
                            <div style={{ fontSize: 11, color: C.textDim, marginBottom: 14 }}>Paste the Notion database ID for each. Leave blank to skip or use Opxio defaults.</div>
                            <Grid cols={2}>
                              {keys.map(key => (
                                <Field key={key} label={key}>
                                  <Input value={form.databases[key] || ""} onChange={e => setDB(key, e.target.value)} placeholder="notion db id…" />
                                </Field>
                              ))}
                            </Grid>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── Stages ── */}
                  {tab === "Stages" && (
                    <div>
                      <SectionHead>Lead Stages — CRM Pipeline</SectionHead>
                      <div style={{ background: C.surface, borderRadius: 10, padding: "14px 16px", border: `1px solid ${C.border}`, marginBottom: 20 }}>
                        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 14 }}>Comma-separated stage names matching exactly what's in the client's Notion CRM status field.</div>
                        <Field label="All Stages" hint="in order, comma-separated">
                          <Input value={form.labels.stages} onChange={e => setLbl("stages", e.target.value)} placeholder="Lead, Contacted, Qualified, Converted-Won, Closed-Lost" />
                        </Field>
                        <Field label="Active Stages" hint="stages shown on funnel board — pre-close only">
                          <Input value={form.labels.activeStages} onChange={e => setLbl("activeStages", e.target.value)} placeholder="Lead, Contacted, Qualified" />
                        </Field>
                      </div>

                      <SectionHead>Deal Stages — Deals Widget</SectionHead>
                      <div style={{ background: C.surface, borderRadius: 10, padding: "14px 16px", border: `1px solid ${C.border}` }}>
                        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 14 }}>Configures the deals board and pipeline value widgets. Comma-separated, matching Notion exactly.</div>
                        <Field label="All Deal Stages" hint="in order">
                          <Input value={form.labels.dealAll} onChange={e => setLbl("dealAll", e.target.value)} placeholder="Incoming, Negotiation, Proposal, Client Active, Delivered–Closed, Lost" />
                        </Field>
                        <Grid cols={2}>
                          <Field label="Potential Stages" hint="pre-won, shown in pipeline value">
                            <Input value={form.labels.dealPotential} onChange={e => setLbl("dealPotential", e.target.value)} placeholder="Incoming, Negotiation, Proposal" />
                          </Field>
                          <Field label="Won Stages" hint="active build stages">
                            <Input value={form.labels.dealWon} onChange={e => setLbl("dealWon", e.target.value)} placeholder="Client Active, Delivered–Closed" />
                          </Field>
                          <Field label="Won Label" hint="first won stage, for 'won this month'">
                            <Input value={form.labels.dealWonLabel} onChange={e => setLbl("dealWonLabel", e.target.value)} placeholder="Client Active" />
                          </Field>
                          <Field label="Delivered Label" hint="completed/delivered stage name">
                            <Input value={form.labels.dealDeliveredLabel} onChange={e => setLbl("dealDeliveredLabel", e.target.value)} placeholder="Delivered–Closed" />
                          </Field>
                        </Grid>
                      </div>
                    </div>
                  )}

                  {/* ── Widgets ── */}
                  {tab === "Widgets" && (
                    <div>
                      <SectionHead>Widget Access</SectionHead>
                      <div style={{ fontSize: 11, color: C.textDim, marginBottom: 16 }}>Toggle which widgets this client has access to. Red "missing DBs" means the required database IDs aren't filled in under Notion & DBs.</div>
                      <div style={{ background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>
                        {WIDGETS.map((w, i) => {
                          const enabled = form.custom_widgets.includes(w.url)
                          const missing = w.dbs.filter(db => !form.databases?.[db])
                          return (
                            <div key={w.url} onClick={() => toggleW(w.url)}
                              style={{ display: "flex", alignItems: "center", padding: "13px 16px", borderBottom: i < WIDGETS.length - 1 ? `1px solid ${C.border2}` : "none", cursor: "pointer", background: enabled ? "rgba(170,255,0,.03)" : "transparent" }}>
                              {/* Toggle */}
                              <div style={{ width: 34, height: 20, borderRadius: 99, background: enabled ? C.lime : "rgba(255,255,255,.1)", position: "relative", flexShrink: 0, transition: "background .2s" }}>
                                <div style={{ position: "absolute", top: 4, left: enabled ? 16 : 4, width: 12, height: 12, borderRadius: "50%", background: enabled ? "#111" : "rgba(255,255,255,.4)", transition: "left .2s" }} />
                              </div>
                              <div style={{ marginLeft: 14, flex: 1 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: enabled ? C.text : C.textMid }}>{w.label}</span>
                                  <span style={{ fontSize: 9, fontWeight: 700, background: w.tier === "base" ? C.limeDim : C.amberDim, color: w.tier === "base" ? C.lime : C.amber, padding: "2px 6px", borderRadius: 4 }}>{w.tier.toUpperCase()}</span>
                                  {missing.length > 0 && enabled && <span style={{ fontSize: 10, color: C.red, fontWeight: 600 }}>⚠ missing: {missing.join(", ")}</span>}
                                </div>
                                <div style={{ fontSize: 10, color: C.textDim, fontFamily: "monospace" }}>{w.url}</div>
                              </div>
                              <span style={{ fontSize: 11, fontWeight: 700, color: enabled ? C.lime : C.textDim, marginLeft: 12 }}>{enabled ? "On" : "Off"}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── Access ── */}
                  {tab === "Access" && (
                    <div>
                      <SectionHead>Access Token</SectionHead>
                      <div style={{ fontSize: 11, color: C.textDim, marginBottom: 16 }}>This token authenticates all widget API calls for this client. Treat it like a password — give it to the client to embed in their widget URLs.</div>
                      {form.access_token ? (
                        <div>
                          <div onClick={() => copy(form.access_token)}
                            style={{ background: "#1a1a1e", border: `1px solid ${C.limeBorder}`, borderRadius: 9, padding: "12px 14px", fontFamily: "monospace", fontSize: 12, color: C.lime, wordBreak: "break-all", cursor: "pointer", marginBottom: 10, userSelect: "all" }}>
                            {form.access_token}
                            <span style={{ opacity: .4, fontSize: 10, marginLeft: 8, fontFamily: "'Satoshi',sans-serif" }}>click to copy</span>
                          </div>
                          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                            <button onClick={() => copy(form.access_token)} style={{ background: C.limeDim, color: C.lime, border: `1px solid ${C.limeBorder}`, fontSize: 12, fontWeight: 700, padding: "7px 16px", borderRadius: 7, cursor: "pointer" }}>Copy Token</button>
                            {selected !== "__new__" && (
                              <button onClick={regenToken} style={{ background: C.redDim, color: C.red, border: `1px solid ${C.redBorder}`, fontSize: 12, fontWeight: 700, padding: "7px 16px", borderRadius: 7, cursor: "pointer" }}>↻ Regenerate</button>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: C.textDim }}>⚠ Regenerating immediately invalidates the existing token. The client will need to update their widget embeds.</div>
                        </div>
                      ) : (
                        <div style={{ fontSize: 13, color: C.textDim }}>Token is auto-generated when you save a new client.</div>
                      )}

                      {selected !== "__new__" && (
                        <>
                          <SectionHead style={{ marginTop: 28 }}>Widget URL Builder</SectionHead>
                          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 12 }}>Quick reference for building embed URLs for this client.</div>
                          <div style={{ background: C.surface, borderRadius: 9, padding: "12px 14px", border: `1px solid ${C.border}` }}>
                            <div style={{ fontFamily: "monospace", fontSize: 11, color: C.textMid, wordBreak: "break-all" }}>
                              https://dashboard.opxio.io<span style={{ color: C.lime }}>/[widget-path]</span>?token=<span style={{ color: C.lime }}>{form.access_token?.slice(0, 12)}…</span>
                            </div>
                          </div>
                          <button onClick={() => setUrlModal(selected)} style={{ marginTop: 12, background: C.limeDim, color: C.lime, border: `1px solid ${C.limeBorder}`, fontSize: 12, fontWeight: 700, padding: "8px 18px", borderRadius: 8, cursor: "pointer" }}>
                            View All Widget URLs →
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Save bar */}
                  <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}>
                    <button onClick={save} disabled={saving}
                      style={{ background: C.lime, color: "#111", fontWeight: 900, fontSize: 13, padding: "10px 26px", borderRadius: 9, border: "none", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? .7 : 1 }}>
                      {saving ? "Saving…" : selected === "__new__" ? "Create Client" : "Save Changes"}
                    </button>
                    <button onClick={() => setSelected(null)}
                      style={{ background: C.surface3, color: C.textMid, fontWeight: 700, fontSize: 12, padding: "9px 18px", borderRadius: 9, border: `1px solid ${C.border}`, cursor: "pointer" }}>
                      Cancel
                    </button>
                  </div>

                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
