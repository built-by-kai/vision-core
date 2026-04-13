import { useState, useEffect, useCallback } from "react"
import Head from "next/head"
import crypto from "crypto"

const ADMIN_KEY = "opxio-admin-2026"
const BASE      = typeof window !== "undefined" ? window.location.origin : ""

// All DB keys the system supports, grouped by OS
const DB_GROUPS = {
  "Revenue OS": ["LEADS","DEALS","QUOTATIONS","PROPOSALS","INVOICE","RECEIPT","EXPANSIONS","FINANCE"],
  "Operations OS": ["PROJECTS","PHASES","TASKS","MEETINGS","RETAINERS","SOPS","RESP_MATRIX","CLIENT_IMPL"],
}

// Widget definitions: { url, label, requiredDBs }
const WIDGETS = [
  { url: "/revenue/crm",      label: "CRM & Pipeline",    dbs: ["LEADS","DEALS"] },
  { url: "/revenue/overview", label: "Revenue Overview",  dbs: ["QUOTATIONS","INVOICE"] },
  { url: "/revenue/finance",  label: "Finance Snapshot",  dbs: ["FINANCE"] },
  { url: "/revenue/deals",    label: "Deals",             dbs: ["DEALS","QUOTATIONS","PROPOSALS"] },
  { url: "/revenue/leads",    label: "Leads",             dbs: ["LEADS"] },
  { url: "/revenue/billing",  label: "Billing",           dbs: ["INVOICE"] },
  { url: "/revenue/schedule", label: "Schedule",          dbs: ["MEETINGS"] },
  { url: "/revenue/visitors", label: "Visitor Insights",  dbs: ["LEADS"] },
  { url: "/revenue/topproducts", label: "Top Products",   dbs: ["QUOTATIONS"] },
  { url: "/operations/projects", label: "Projects",       dbs: ["PROJECTS","PHASES"] },
]

const EMPTY_CLIENT = {
  client_name: "", slug: "", os_type: [], notion_token: "", status: "active",
  databases: {}, field_map: { STAGE_FIELD: "" },
  labels: { stages: "", activeStages: "" },
  monthly_fee: 0,
}

function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?"
  return fetch(`/api/admin/clients${path}${sep}adminKey=${ADMIN_KEY}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  }).then(r => r.json())
}

export default function AdminPage() {
  const [authed,   setAuthed]   = useState(false)
  const [keyInput, setKeyInput] = useState("")
  const [clients,  setClients]  = useState([])
  const [selected, setSelected] = useState(null) // editing client
  const [form,     setForm]     = useState(EMPTY_CLIENT)
  const [saving,   setSaving]   = useState(false)
  const [toast,    setToast]    = useState("")
  const [delConfirm, setDelConfirm] = useState(null)
  const [showWidgets, setShowWidgets] = useState(null) // client slug

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(""), 3000)
  }

  async function loadClients() {
    const data = await api("")
    if (Array.isArray(data)) setClients(data)
  }

  useEffect(() => { if (authed) loadClients() }, [authed])

  function openNew() {
    setSelected("__new__")
    setForm({ ...EMPTY_CLIENT, notion_token: "" })
  }

  function openEdit(c) {
    setSelected(c.slug)
    setForm({
      client_name:  c.client_name,
      slug:         c.slug,
      os_type:      c.os_type || [],
      notion_token: c.notion_token || "",
      status:       c.status || "active",
      databases:    { ...c.databases },
      field_map:    { STAGE_FIELD: c.field_map?.STAGE_FIELD || "", ...c.field_map },
      labels: {
        stages:       (c.labels?.stages || []).join(", "),
        activeStages: (c.labels?.activeStages || []).join(", "),
      },
      monthly_fee: c.monthly_fee || 0,
      access_token: c.access_token,
    })
  }

  function setDB(key, val) {
    setForm(f => ({ ...f, databases: { ...f.databases, [key]: val } }))
  }
  function setFieldMap(key, val) {
    setForm(f => ({ ...f, field_map: { ...f.field_map, [key]: val } }))
  }
  function setLabel(key, val) {
    setForm(f => ({ ...f, labels: { ...f.labels, [key]: val } }))
  }
  function toggleOS(os) {
    setForm(f => {
      const arr = f.os_type.includes(os) ? f.os_type.filter(x => x !== os) : [...f.os_type, os]
      return { ...f, os_type: arr }
    })
  }

  function buildPayload() {
    const labels = {}
    if (form.labels.stages.trim()) {
      labels.stages = form.labels.stages.split(",").map(s => s.trim()).filter(Boolean)
    }
    if (form.labels.activeStages.trim()) {
      labels.activeStages = form.labels.activeStages.split(",").map(s => s.trim()).filter(Boolean)
    }
    const field_map = {}
    if (form.field_map.STAGE_FIELD) field_map.STAGE_FIELD = form.field_map.STAGE_FIELD
    const databases = {}
    for (const [k, v] of Object.entries(form.databases)) {
      if (v && v.trim()) databases[k] = v.trim()
    }
    return { ...form, databases, field_map, labels }
  }

  async function save() {
    setSaving(true)
    try {
      if (selected === "__new__") {
        const res = await api("", { method: "POST", body: JSON.stringify(buildPayload()) })
        if (res.error) { showToast("Error: " + res.error); return }
        showToast("Client created ✓")
      } else {
        const res = await api(`?slug=${selected}`, { method: "PUT", body: JSON.stringify(buildPayload()) })
        if (res.error) { showToast("Error: " + res.error); return }
        showToast("Saved ✓")
      }
      await loadClients()
      setSelected(null)
    } finally { setSaving(false) }
  }

  async function deleteClient(slug) {
    const res = await api(`?slug=${slug}`, { method: "DELETE" })
    if (res.error) { showToast("Error: " + res.error); return }
    showToast("Deleted")
    setDelConfirm(null)
    setSelected(null)
    await loadClients()
  }

  function copy(text) {
    navigator.clipboard.writeText(text)
    showToast("Copied!")
  }

  const clientForWidgets = showWidgets ? clients.find(c => c.slug === showWidgets) : null

  // ── Styles ────────────────────────────────────────────────────────────────
  const s = {
    page:      { minHeight: "100vh", background: "#191919", color: "#fff", fontFamily: "'Satoshi',-apple-system,sans-serif", padding: "0" },
    topbar:    { background: "#141414", borderBottom: "1px solid rgba(255,255,255,.07)", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" },
    logo:      { fontSize: 14, fontWeight: 900, letterSpacing: ".06em", color: "#AAFF00" },
    content:   { display: "flex", height: "calc(100vh - 53px)" },
    sidebar:   { width: 300, borderRight: "1px solid rgba(255,255,255,.07)", overflowY: "auto", flexShrink: 0 },
    main:      { flex: 1, overflowY: "auto", padding: 28 },
    // list
    listHdr:   { padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.06)", display: "flex", alignItems: "center", justifyContent: "space-between" },
    listTitle: { fontSize: 10, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase", color: "rgba(255,255,255,.35)" },
    addBtn:    { background: "#AAFF00", color: "#111", fontSize: 11, fontWeight: 900, padding: "5px 12px", borderRadius: 7, border: "none", cursor: "pointer" },
    clientRow: { padding: "11px 16px", borderBottom: "1px solid rgba(255,255,255,.04)", cursor: "pointer", transition: "background .15s" },
    clientName:{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 2 },
    clientMeta:{ fontSize: 10, color: "rgba(255,255,255,.3)", display: "flex", gap: 8 },
    // form
    formTitle: { fontSize: 18, fontWeight: 900, letterSpacing: "-.03em", marginBottom: 4 },
    sectionLbl:{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em", color: "rgba(255,255,255,.25)", margin: "22px 0 10px" },
    field:     { marginBottom: 12 },
    label:     { display: "block", fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,.35)", marginBottom: 5, textTransform: "uppercase", letterSpacing: ".08em" },
    input:     { width: "100%", background: "#252525", border: "1px solid rgba(255,255,255,.09)", borderRadius: 8, color: "#fff", fontFamily: "'Satoshi',sans-serif", fontSize: 13, padding: "8px 12px", outline: "none", boxSizing: "border-box" },
    tokenBox:  { background: "#1a1a1a", border: "1px solid rgba(170,255,0,.2)", borderRadius: 8, padding: "10px 12px", fontFamily: "monospace", fontSize: 11, color: "#AAFF00", wordBreak: "break-all", cursor: "pointer", userSelect: "all" },
    saveBtn:   { background: "#AAFF00", color: "#111", fontWeight: 900, fontSize: 13, padding: "10px 24px", borderRadius: 9, border: "none", cursor: "pointer", marginRight: 8 },
    cancelBtn: { background: "#252525", color: "rgba(255,255,255,.5)", fontWeight: 700, fontSize: 13, padding: "10px 18px", borderRadius: 9, border: "1px solid rgba(255,255,255,.09)", cursor: "pointer" },
    delBtn:    { background: "rgba(255,80,80,.12)", color: "#FF5050", fontWeight: 700, fontSize: 12, padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(255,80,80,.2)", cursor: "pointer", marginLeft: "auto" },
    osChip:    (active) => ({ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer", background: active ? "rgba(170,255,0,.15)" : "#252525", color: active ? "#AAFF00" : "rgba(255,255,255,.4)", transition: "all .15s", marginRight: 6 }),
    // widget modal
    overlay:   { position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" },
    modal:     { background: "#1E1E1E", borderRadius: 16, padding: 28, width: 640, maxHeight: "80vh", overflowY: "auto", border: "1px solid rgba(255,255,255,.08)" },
    wRow:      { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.05)" },
    wLabel:    { fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 3 },
    wUrl:      { fontSize: 11, color: "#AAFF00", fontFamily: "monospace", wordBreak: "break-all" },
    copyBtn:   { background: "rgba(170,255,0,.1)", color: "#AAFF00", border: "1px solid rgba(170,255,0,.2)", borderRadius: 6, fontSize: 10, fontWeight: 700, padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap", marginLeft: 12, flexShrink: 0 },
    // toast
    toast:     { position: "fixed", bottom: 24, right: 24, background: "#AAFF00", color: "#111", fontWeight: 900, fontSize: 13, padding: "10px 18px", borderRadius: 10, zIndex: 999 },
    // login
    loginWrap: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#191919" },
    loginBox:  { background: "#1E1E1E", borderRadius: 16, padding: "36px 32px", width: 340, border: "1px solid rgba(255,255,255,.07)" },
  }

  // ── Login screen ──────────────────────────────────────────────────────────
  if (!authed) return (
    <>
      <Head><title>Opxio Admin</title><link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet"/></Head>
      <div style={s.loginWrap}>
        <div style={s.loginBox}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#AAFF00", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 6 }}>OPXIO</div>
          <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: "-.04em", marginBottom: 20 }}>Admin Panel</div>
          <input
            style={{ ...s.input, marginBottom: 12 }}
            type="password"
            placeholder="Admin key"
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && (keyInput === ADMIN_KEY ? setAuthed(true) : showToast("Wrong key"))}
          />
          <button style={s.saveBtn} onClick={() => keyInput === ADMIN_KEY ? setAuthed(true) : showToast("Wrong key")}>
            Enter
          </button>
        </div>
      </div>
    </>
  )

  // ── Main admin UI ─────────────────────────────────────────────────────────
  return (
    <>
      <Head><title>Opxio Admin</title><link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet"/></Head>

      {toast && <div style={s.toast}>{toast}</div>}

      {/* Widget URLs modal */}
      {showWidgets && clientForWidgets && (
        <div style={s.overlay} onClick={() => setShowWidgets(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 18, letterSpacing: "-.03em" }}>
              Widget URLs — {clientForWidgets.client_name}
            </div>
            {WIDGETS.map(w => {
              const url = `https://dashboard.opxio.io${w.url}?token=${clientForWidgets.access_token}`
              const hasDBs = w.dbs.every(db => clientForWidgets.databases?.[db] || db === "LEADS" || db === "DEALS")
              return (
                <div key={w.url} style={s.wRow}>
                  <div style={{ flex: 1 }}>
                    <div style={{ ...s.wLabel, opacity: hasDBs ? 1 : .4 }}>{w.label}</div>
                    <div style={{ ...s.wUrl, opacity: hasDBs ? 1 : .3 }}>{url}</div>
                    {!hasDBs && <div style={{ fontSize: 9, color: "rgba(255,80,80,.7)", marginTop: 2 }}>Missing DBs: {w.dbs.filter(db => !clientForWidgets.databases?.[db]).join(", ")}</div>}
                  </div>
                  <button style={s.copyBtn} onClick={() => copy(url)}>Copy</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {delConfirm && (
        <div style={s.overlay}>
          <div style={{ ...s.modal, width: 360 }}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 12 }}>Delete client?</div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,.5)", marginBottom: 24 }}>This will permanently delete <strong style={{ color: "#fff" }}>{delConfirm}</strong> and invalidate their token.</div>
            <button style={{ ...s.saveBtn, background: "#FF5050" }} onClick={() => deleteClient(delConfirm)}>Delete</button>
            <button style={s.cancelBtn} onClick={() => setDelConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div style={s.page}>
        <div style={s.topbar}>
          <span style={s.logo}>OPXIO ADMIN</span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,.25)" }}>{clients.length} clients</span>
        </div>
        <div style={s.content}>

          {/* Sidebar — client list */}
          <div style={s.sidebar}>
            <div style={s.listHdr}>
              <span style={s.listTitle}>Clients</span>
              <button style={s.addBtn} onClick={openNew}>+ Add</button>
            </div>
            {clients.map(c => (
              <div key={c.slug}
                style={{ ...s.clientRow, background: selected === c.slug ? "rgba(170,255,0,.06)" : "transparent" }}
                onClick={() => openEdit(c)}
              >
                <div style={s.clientName}>{c.client_name}</div>
                <div style={s.clientMeta}>
                  <span>{c.slug}</span>
                  <span style={{ color: c.status === "active" ? "#AAFF00" : "rgba(255,80,80,.7)" }}>● {c.status}</span>
                  {c.os_type?.map(o => <span key={o}>{o}</span>)}
                </div>
              </div>
            ))}
          </div>

          {/* Main — edit form */}
          <div style={s.main}>
            {!selected && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "rgba(255,255,255,.2)", fontSize: 14 }}>
                Select a client or add a new one
              </div>
            )}
            {selected && (
              <div style={{ maxWidth: 720 }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 24, gap: 12 }}>
                  <div style={s.formTitle}>{selected === "__new__" ? "New Client" : form.client_name}</div>
                  {selected !== "__new__" && (
                    <>
                      <button style={s.copyBtn} onClick={() => setShowWidgets(selected)}>View Widget URLs</button>
                      <button style={{ ...s.delBtn }} onClick={() => setDelConfirm(selected)}>Delete</button>
                    </>
                  )}
                </div>

                {/* Basic info */}
                <div style={s.sectionLbl}>Basic Info</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div style={s.field}>
                    <label style={s.label}>Client Name</label>
                    <input style={s.input} value={form.client_name} onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))} placeholder="Creaitors" />
                  </div>
                  <div style={s.field}>
                    <label style={s.label}>Slug</label>
                    <input style={s.input} value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/\s+/g,"-") }))} placeholder="creaitors" disabled={selected !== "__new__"} />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div style={s.field}>
                    <label style={s.label}>Status</label>
                    <select style={{ ...s.input, cursor: "pointer" }} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="paused">Paused</option>
                    </select>
                  </div>
                  <div style={s.field}>
                    <label style={s.label}>Monthly Fee (RM)</label>
                    <input style={s.input} type="number" value={form.monthly_fee} onChange={e => setForm(f => ({ ...f, monthly_fee: Number(e.target.value) }))} placeholder="0" />
                  </div>
                </div>

                {/* OS Type */}
                <div style={s.sectionLbl}>OS Type</div>
                <div style={{ marginBottom: 16 }}>
                  {["business","sales","operations","marketing","intelligence"].map(os => (
                    <button key={os} style={s.osChip(form.os_type.includes(os))} onClick={() => toggleOS(os)}>{os}</button>
                  ))}
                </div>

                {/* Notion token */}
                <div style={s.sectionLbl}>Notion</div>
                <div style={s.field}>
                  <label style={s.label}>Notion API Token <span style={{ color: "rgba(255,255,255,.2)", fontWeight: 400, textTransform: "none" }}>— leave blank to use Opxio shared key</span></label>
                  <input style={s.input} value={form.notion_token} onChange={e => setForm(f => ({ ...f, notion_token: e.target.value }))} placeholder="ntn_..." />
                </div>

                {/* DB IDs */}
                {Object.entries(DB_GROUPS).map(([group, keys]) => (
                  <div key={group}>
                    <div style={s.sectionLbl}>{group} — Database IDs <span style={{ color: "rgba(255,255,255,.18)", fontWeight: 400, textTransform: "none" }}>leave blank to skip</span></div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {keys.map(key => (
                        <div key={key} style={s.field}>
                          <label style={s.label}>{key}</label>
                          <input style={s.input} value={form.databases[key] || ""} onChange={e => setDB(key, e.target.value)} placeholder="notion db id..." />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {/* Pipeline config */}
                <div style={s.sectionLbl}>Pipeline / CRM Config <span style={{ color: "rgba(255,255,255,.18)", fontWeight: 400, textTransform: "none" }}>for CRM widget</span></div>
                <div style={s.field}>
                  <label style={s.label}>Stage Field Name <span style={{ color: "rgba(255,255,255,.2)", fontWeight: 400, textTransform: "none" }}>default: Stage</span></label>
                  <input style={s.input} value={form.field_map.STAGE_FIELD || ""} onChange={e => setFieldMap("STAGE_FIELD", e.target.value)} placeholder="Stage" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>All Stages <span style={{ color: "rgba(255,255,255,.2)", fontWeight: 400, textTransform: "none" }}>comma separated, last two = won / lost</span></label>
                  <input style={s.input} value={form.labels.stages || ""} onChange={e => setLabel("stages", e.target.value)} placeholder="Lead, Contacted, Qualified, Closed-Won, Closed-Lost" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Active Stages <span style={{ color: "rgba(255,255,255,.2)", fontWeight: 400, textTransform: "none" }}>pre-close stages to show on board</span></label>
                  <input style={s.input} value={form.labels.activeStages || ""} onChange={e => setLabel("activeStages", e.target.value)} placeholder="Lead, Contacted, Qualified" />
                </div>

                {/* Access token */}
                <div style={s.sectionLbl}>Access Token</div>
                {form.access_token ? (
                  <div style={s.tokenBox} onClick={() => copy(form.access_token)}>{form.access_token} <span style={{ opacity: .4, fontSize: 9 }}>click to copy</span></div>
                ) : (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,.3)", marginBottom: 12 }}>Auto-generated on save</div>
                )}

                {/* Actions */}
                <div style={{ marginTop: 28, display: "flex", alignItems: "center" }}>
                  <button style={s.saveBtn} onClick={save} disabled={saving}>{saving ? "Saving…" : selected === "__new__" ? "Create Client" : "Save Changes"}</button>
                  <button style={s.cancelBtn} onClick={() => setSelected(null)}>Cancel</button>
                  {selected !== "__new__" && form.access_token && (
                    <button style={{ ...s.copyBtn, marginLeft: "auto" }} onClick={() => setShowWidgets(selected)}>View Widget URLs →</button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
