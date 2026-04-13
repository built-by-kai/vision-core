import { useState, useEffect } from "react"
import Head from "next/head"

const ADMIN_KEY = "opxio-admin-2026"

// All DB keys, grouped by OS
const DB_GROUPS = {
  "Revenue OS": ["LEADS","DEALS","QUOTATIONS","PROPOSALS","INVOICE","RECEIPT","EXPANSIONS","FINANCE"],
  "Operations OS": ["PROJECTS","PHASES","TASKS","MEETINGS","RETAINERS","SOPS","RESP_MATRIX","CLIENT_IMPL"],
}

// Every widget — url, label, required DBs, which OS package it belongs to, whether it's a base or add-on
const WIDGETS = [
  { url: "/revenue/crm",         label: "CRM & Pipeline",    dbs: ["LEADS","DEALS"],                      os: "sales",      tier: "base" },
  { url: "/revenue/overview",    label: "Revenue Overview",  dbs: ["QUOTATIONS","INVOICE"],               os: "sales",      tier: "base" },
  { url: "/revenue/deals",       label: "Deals",             dbs: ["DEALS","QUOTATIONS","PROPOSALS"],     os: "sales",      tier: "base" },
  { url: "/revenue/leads",       label: "Leads",             dbs: ["LEADS"],                              os: "sales",      tier: "base" },
  { url: "/revenue/billing",     label: "Billing",           dbs: ["INVOICE"],                            os: "sales",      tier: "base" },
  { url: "/revenue/visitors",    label: "Visitor Insights",  dbs: ["LEADS"],                              os: "sales",      tier: "addon" },
  { url: "/revenue/topproducts", label: "Top Products",      dbs: ["QUOTATIONS"],                         os: "sales",      tier: "addon" },
  { url: "/revenue/schedule",    label: "Schedule",          dbs: ["MEETINGS"],                           os: "sales",      tier: "addon" },
  { url: "/revenue/finance",     label: "Finance Snapshot",  dbs: ["FINANCE"],                            os: "sales",      tier: "addon" },
  { url: "/operations/projects", label: "Projects",          dbs: ["PROJECTS","PHASES"],                  os: "operations", tier: "base" },
]

const OS_TYPES = ["business","sales","operations","marketing","intelligence"]

const EMPTY_CLIENT = {
  client_name: "", slug: "", os_type: [], notion_token: "", status: "active",
  databases: {},
  field_map: { STAGE_FIELD: "", STATUS_FIELD: "", PACKAGE_FIELD: "", TYPE_FIELD: "", INVOICE_TYPE_FIELD: "" },
  labels: { stages: "", activeStages: "" },
  monthly_fee: 0, next_renewal: "",
  custom_widgets: [],
  installed_os: {},
}

function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?"
  return fetch(`/api/admin/clients${path}${sep}adminKey=${ADMIN_KEY}`, {
    headers: { "Content-Type": "application/json" }, ...opts,
  }).then(r => r.json())
}

// ─── Styles ────────────────────────────────────────────────────────────────
const C = {
  bg: "#191919", surface: "#1E1E1E", surface2: "#252525",
  border: "rgba(255,255,255,.07)", border2: "rgba(255,255,255,.04)",
  lime: "#AAFF00", limeDim: "rgba(170,255,0,.12)", limeBorder: "rgba(170,255,0,.2)",
  text: "#fff", textMid: "rgba(255,255,255,.5)", textDim: "rgba(255,255,255,.25)",
  red: "#FF5050", redDim: "rgba(255,80,80,.12)", redBorder: "rgba(255,80,80,.2)",
  amber: "#FBBF24",
}
const s = {
  page:     { minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'Satoshi',-apple-system,sans-serif" },
  topbar:   { background:"#141414", borderBottom:`1px solid ${C.border}`, padding:"14px 28px", display:"flex", alignItems:"center", justifyContent:"space-between" },
  logo:     { fontSize:14, fontWeight:900, letterSpacing:".06em", color:C.lime },
  content:  { display:"flex", height:"calc(100vh - 53px)" },
  sidebar:  { width:280, borderRight:`1px solid ${C.border}`, overflowY:"auto", flexShrink:0 },
  main:     { flex:1, overflowY:"auto", padding:"28px 32px" },
  listHdr:  { padding:"14px 16px", borderBottom:`1px solid ${C.border2}`, display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, background:"#141414", zIndex:1 },
  listTitle:{ fontSize:10, fontWeight:700, letterSpacing:".12em", textTransform:"uppercase", color:C.textDim },
  addBtn:   { background:C.lime, color:"#111", fontSize:11, fontWeight:900, padding:"5px 12px", borderRadius:7, border:"none", cursor:"pointer" },
  clientRow:(active) => ({ padding:"11px 16px", borderBottom:`1px solid ${C.border2}`, cursor:"pointer", background: active ? "rgba(170,255,0,.06)" : "transparent" }),
  cName:    { fontSize:13, fontWeight:700, color:C.text, marginBottom:2 },
  cMeta:    { fontSize:10, color:C.textDim, display:"flex", gap:8, flexWrap:"wrap" },
  formTitle:{ fontSize:20, fontWeight:900, letterSpacing:"-.04em", marginBottom:4 },
  secLabel: { fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:".12em", color:C.textDim, margin:"22px 0 10px", display:"block" },
  secNote:  { fontWeight:400, textTransform:"none", color:"rgba(255,255,255,.18)", marginLeft:6 },
  fieldWrap:{ marginBottom:12 },
  lbl:      { display:"block", fontSize:10, fontWeight:700, color:"rgba(255,255,255,.35)", marginBottom:5, textTransform:"uppercase", letterSpacing:".08em" },
  input:    { width:"100%", background:C.surface2, border:`1px solid rgba(255,255,255,.09)`, borderRadius:8, color:C.text, fontFamily:"'Satoshi',sans-serif", fontSize:13, padding:"8px 12px", outline:"none", boxSizing:"border-box" },
  chip:     (active, color) => ({ padding:"5px 13px", borderRadius:6, fontSize:11, fontWeight:700, border:"none", cursor:"pointer", marginRight:6, marginBottom:6, background: active ? (color||C.limeDim) : C.surface2, color: active ? (color==="rgba(255,80,80,.15)"? C.red : C.lime) : C.textMid, transition:"all .15s" }),
  saveBtn:  { background:C.lime, color:"#111", fontWeight:900, fontSize:13, padding:"10px 24px", borderRadius:9, border:"none", cursor:"pointer", marginRight:8 },
  ghostBtn: { background:C.surface2, color:C.textMid, fontWeight:700, fontSize:12, padding:"8px 14px", borderRadius:8, border:`1px solid rgba(255,255,255,.09)`, cursor:"pointer" },
  dangerBtn:{ background:C.redDim, color:C.red, fontWeight:700, fontSize:12, padding:"8px 14px", borderRadius:8, border:`1px solid ${C.redBorder}`, cursor:"pointer" },
  tokenBox: { background:"#1a1a1a", border:`1px solid ${C.limeBorder}`, borderRadius:8, padding:"10px 12px", fontFamily:"monospace", fontSize:11, color:C.lime, wordBreak:"break-all", cursor:"pointer", userSelect:"all", marginBottom:8 },
  copyBtn:  { background:C.limeDim, color:C.lime, border:`1px solid ${C.limeBorder}`, borderRadius:6, fontSize:10, fontWeight:700, padding:"4px 10px", cursor:"pointer", whiteSpace:"nowrap" },
  wRow:     { display:"flex", alignItems:"flex-start", justifyContent:"space-between", padding:"10px 0", borderBottom:`1px solid ${C.border2}` },
  overlay:  { position:"fixed", inset:0, background:"rgba(0,0,0,.75)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center" },
  modal:    { background:C.surface, borderRadius:16, padding:28, width:680, maxHeight:"82vh", overflowY:"auto", border:`1px solid ${C.border}` },
  toast:    { position:"fixed", bottom:24, right:24, background:C.lime, color:"#111", fontWeight:900, fontSize:13, padding:"10px 18px", borderRadius:10, zIndex:999, pointerEvents:"none" },
  badge:    (col) => ({ fontSize:9, fontWeight:700, padding:"2px 7px", borderRadius:4, background: col==="lime" ? C.limeDim : col==="red" ? C.redDim : "rgba(255,191,36,.1)", color: col==="lime" ? C.lime : col==="red" ? C.red : C.amber, border:`1px solid ${col==="lime" ? C.limeBorder : col==="red" ? C.redBorder : "rgba(255,191,36,.25)"}` }),
}

export default function AdminPage() {
  const [authed,   setAuthed]   = useState(false)
  const [keyInput, setKeyInput] = useState("")
  const [clients,  setClients]  = useState([])
  const [selected, setSelected] = useState(null)
  const [form,     setForm]     = useState(EMPTY_CLIENT)
  const [saving,   setSaving]   = useState(false)
  const [toast,    setToast]    = useState("")
  const [delSlug,  setDelSlug]  = useState(null)
  const [widgetModal, setWidgetModal] = useState(null)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3000) }
  const copy = (txt) => { navigator.clipboard?.writeText(txt); showToast("Copied!") }

  async function loadClients() {
    const data = await api("")
    if (Array.isArray(data)) setClients(data)
  }
  useEffect(() => { if (authed) loadClients() }, [authed])

  function clientFromForm(c) {
    return {
      client_name:  c.client_name,
      slug:         c.slug,
      os_type:      c.os_type || [],
      notion_token: c.notion_token || "",
      status:       c.status,
      databases:    Object.fromEntries(Object.entries(c.databases||{}).filter(([,v]) => v?.trim())),
      field_map:    c.field_map?.STAGE_FIELD ? { STAGE_FIELD: c.field_map.STAGE_FIELD } : {},
      labels: {
        ...(c.labels?.stages?.trim()       ? { stages:       c.labels.stages.split(",").map(s=>s.trim()).filter(Boolean) } : {}),
        ...(c.labels?.activeStages?.trim() ? { activeStages: c.labels.activeStages.split(",").map(s=>s.trim()).filter(Boolean) } : {}),
      },
      monthly_fee:    Number(c.monthly_fee) || 0,
      next_renewal:   c.next_renewal || null,
      custom_widgets: c.custom_widgets || [],
      installed_os:   c.installed_os   || {},
    }
  }

  function openNew() {
    setSelected("__new__")
    setForm({ ...EMPTY_CLIENT })
  }

  function openEdit(c) {
    setSelected(c.slug)
    setForm({
      client_name:  c.client_name,
      slug:         c.slug,
      os_type:      c.os_type || [],
      notion_token: c.notion_token || "",
      status:       c.status || "active",
      databases:    { ...(c.databases||{}) },
      field_map: {
        STAGE_FIELD:        c.field_map?.STAGE_FIELD        || "",
        STATUS_FIELD:       c.field_map?.STATUS_FIELD       || "",
        PACKAGE_FIELD:      c.field_map?.PACKAGE_FIELD      || "",
        TYPE_FIELD:         c.field_map?.TYPE_FIELD         || "",
        INVOICE_TYPE_FIELD: c.field_map?.INVOICE_TYPE_FIELD || "",
      },
      labels: {
        stages:       (c.labels?.stages||[]).join(", "),
        activeStages: (c.labels?.activeStages||[]).join(", "),
      },
      monthly_fee:    c.monthly_fee || 0,
      next_renewal:   c.next_renewal ? c.next_renewal.slice(0,10) : "",
      custom_widgets: c.custom_widgets || [],
      installed_os:   c.installed_os   || {},
      access_token:   c.access_token,
    })
  }

  // helpers
  const setDB    = (k,v) => setForm(f => ({ ...f, databases: { ...f.databases, [k]: v } }))
  const setFM    = (k,v) => setForm(f => ({ ...f, field_map: { ...f.field_map, [k]: v } }))
  const setLbl   = (k,v) => setForm(f => ({ ...f, labels: { ...f.labels, [k]: v } }))
  const toggleOS = (os)  => setForm(f => ({ ...f, os_type: f.os_type.includes(os) ? f.os_type.filter(x=>x!==os) : [...f.os_type, os] }))
  const toggleWidget = (url) => setForm(f => ({ ...f, custom_widgets: f.custom_widgets.includes(url) ? f.custom_widgets.filter(u=>u!==url) : [...f.custom_widgets, url] }))

  async function regenToken() {
    const newTok = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b=>b.toString(16).padStart(2,'0')).join('')
    const res = await api(`?slug=${selected}`, { method:"PUT", body: JSON.stringify({ access_token: newTok }) })
    if (res.error) { showToast("Error: " + res.error); return }
    setForm(f => ({ ...f, access_token: newTok }))
    await loadClients()
    showToast("Token regenerated ✓")
  }

  async function save() {
    setSaving(true)
    try {
      if (selected === "__new__") {
        const res = await api("", { method:"POST", body: JSON.stringify(clientFromForm(form)) })
        if (res.error) { showToast("Error: " + res.error); return }
        showToast("Client created ✓")
      } else {
        const res = await api(`?slug=${selected}`, { method:"PUT", body: JSON.stringify(clientFromForm(form)) })
        if (res.error) { showToast("Error: " + res.error); return }
        showToast("Saved ✓")
      }
      await loadClients()
      setSelected(null)
    } finally { setSaving(false) }
  }

  async function deleteClient(slug) {
    const res = await api(`?slug=${slug}`, { method:"DELETE" })
    if (res.error) { showToast("Error: " + res.error); return }
    showToast("Deleted")
    setDelSlug(null); setSelected(null)
    await loadClients()
  }

  const widgetClient = widgetModal ? clients.find(c=>c.slug===widgetModal) : null

  // ── Login ─────────────────────────────────────────────────────────────────
  if (!authed) return (
    <>
      <Head><title>Opxio Admin</title><link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet"/></Head>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", minHeight:"100vh", background:C.bg }}>
        <div style={{ background:C.surface, borderRadius:16, padding:"36px 32px", width:340, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.lime, letterSpacing:".1em", textTransform:"uppercase", marginBottom:6 }}>OPXIO</div>
          <div style={{ fontSize:22, fontWeight:900, letterSpacing:"-.04em", marginBottom:20 }}>Admin Panel</div>
          <input style={{ ...s.input, marginBottom:12 }} type="password" placeholder="Admin key" value={keyInput}
            onChange={e=>setKeyInput(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&(keyInput===ADMIN_KEY?setAuthed(true):showToast("Wrong key"))} />
          <button style={s.saveBtn} onClick={()=>keyInput===ADMIN_KEY?setAuthed(true):showToast("Wrong key")}>Enter</button>
        </div>
      </div>
    </>
  )

  // ── Main ──────────────────────────────────────────────────────────────────
  return (
    <>
      <Head><title>Opxio Admin</title><link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet"/></Head>
      {toast && <div style={s.toast}>{toast}</div>}

      {/* Widget URLs modal */}
      {widgetModal && widgetClient && (
        <div style={s.overlay} onClick={()=>setWidgetModal(null)}>
          <div style={s.modal} onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:16, fontWeight:900, marginBottom:4, letterSpacing:"-.03em" }}>Widget URLs — {widgetClient.client_name}</div>
            <div style={{ fontSize:11, color:C.textDim, marginBottom:20 }}>Green = enabled in their plan &nbsp;·&nbsp; Dimmed = not yet configured</div>
            {WIDGETS.map(w => {
              const enabled = (widgetClient.custom_widgets||[]).includes(w.url)
              const missingDBs = w.dbs.filter(db => !widgetClient.databases?.[db])
              const url = `https://dashboard.opxio.io${w.url}?token=${widgetClient.access_token}`
              return (
                <div key={w.url} style={{ ...s.wRow, opacity: enabled ? 1 : .35 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
                      <span style={{ fontSize:13, fontWeight:700 }}>{w.label}</span>
                      <span style={s.badge(enabled?"lime":"red")}>{enabled?"Enabled":"Disabled"}</span>
                      <span style={s.badge(w.tier==="base"?"lime":"amber")}>{w.tier}</span>
                    </div>
                    <div style={{ fontFamily:"monospace", fontSize:11, color:C.lime, wordBreak:"break-all" }}>{url}</div>
                    {missingDBs.length>0 && <div style={{ fontSize:9, color:C.red, marginTop:2 }}>Missing DBs: {missingDBs.join(", ")}</div>}
                  </div>
                  <button style={{ ...s.copyBtn, marginLeft:16, flexShrink:0 }} onClick={()=>copy(url)}>Copy</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {delSlug && (
        <div style={s.overlay}>
          <div style={{ ...s.modal, width:360 }}>
            <div style={{ fontSize:16, fontWeight:900, marginBottom:10 }}>Delete client?</div>
            <div style={{ fontSize:13, color:C.textMid, marginBottom:24 }}>
              Permanently deletes <strong style={{ color:C.text }}>{delSlug}</strong> and invalidates their token.
            </div>
            <button style={{ ...s.saveBtn, background:C.red }} onClick={()=>deleteClient(delSlug)}>Delete</button>
            <button style={s.ghostBtn} onClick={()=>setDelSlug(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div style={s.page}>
        <div style={s.topbar}>
          <span style={s.logo}>OPXIO ADMIN</span>
          <span style={{ fontSize:11, color:C.textDim }}>{clients.length} clients</span>
        </div>
        <div style={s.content}>

          {/* ── Sidebar ─────────────────────────────────────────────────── */}
          <div style={s.sidebar}>
            <div style={s.listHdr}>
              <span style={s.listTitle}>Clients</span>
              <button style={s.addBtn} onClick={openNew}>+ Add</button>
            </div>
            {clients.map(c => {
              const isRenewalSoon = c.next_renewal && (new Date(c.next_renewal) - new Date()) < 14*24*60*60*1000
              return (
                <div key={c.slug} style={s.clientRow(selected===c.slug)} onClick={()=>openEdit(c)}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                    <span style={s.cName}>{c.client_name}</span>
                    {isRenewalSoon && <span style={s.badge("amber")}>renews soon</span>}
                  </div>
                  <div style={s.cMeta}>
                    <span>{c.slug}</span>
                    <span style={{ color: c.status==="active" ? C.lime : C.red }}>● {c.status}</span>
                    {c.monthly_fee>0 && <span>RM {c.monthly_fee}/mo</span>}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Main form ───────────────────────────────────────────────── */}
          <div style={s.main}>
            {!selected && (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:C.textDim, fontSize:14 }}>
                Select a client or add a new one
              </div>
            )}
            {selected && (
              <div style={{ maxWidth:720 }}>

                {/* Header */}
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:24, flexWrap:"wrap" }}>
                  <div style={s.formTitle}>{selected==="__new__" ? "New Client" : form.client_name}</div>
                  {selected!=="__new__" && <>
                    <button style={s.copyBtn} onClick={()=>setWidgetModal(selected)}>Widget URLs</button>
                    <button style={{ ...s.dangerBtn, marginLeft:"auto" }} onClick={()=>setDelSlug(selected)}>Delete</button>
                  </>}
                </div>

                {/* ── Basic info ── */}
                <span style={s.secLabel}>Basic Info</span>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>Client Name</label>
                    <input style={s.input} value={form.client_name} onChange={e=>setForm(f=>({...f,client_name:e.target.value}))} placeholder="Creaitors" />
                  </div>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>Slug</label>
                    <input style={s.input} value={form.slug} onChange={e=>setForm(f=>({...f,slug:e.target.value.toLowerCase().replace(/\s+/g,"-")}))} placeholder="creaitors" disabled={selected!=="__new__"} />
                  </div>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>Status</label>
                    <select style={{ ...s.input, cursor:"pointer" }} value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))}>
                      <option value="active">Active</option>
                      <option value="paused">Paused</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>Monthly Fee (RM)</label>
                    <input style={s.input} type="number" value={form.monthly_fee} onChange={e=>setForm(f=>({...f,monthly_fee:e.target.value}))} placeholder="0" />
                  </div>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>Next Renewal</label>
                    <input style={s.input} type="date" value={form.next_renewal} onChange={e=>setForm(f=>({...f,next_renewal:e.target.value}))} />
                  </div>
                </div>

                {/* ── OS Type ── */}
                <span style={s.secLabel}>OS Type</span>
                <div style={{ marginBottom:16 }}>
                  {OS_TYPES.map(os => <button key={os} style={s.chip(form.os_type.includes(os))} onClick={()=>toggleOS(os)}>{os}</button>)}
                </div>

                {/* ── Widget Access ── */}
                <span style={s.secLabel}>Widget Access<span style={s.secNote}>— toggle which widgets this client has in their plan</span></span>
                <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden", marginBottom:4 }}>
                  {WIDGETS.map((w,i) => {
                    const enabled = form.custom_widgets.includes(w.url)
                    const missingDBs = w.dbs.filter(db => !form.databases?.[db])
                    return (
                      <div key={w.url} style={{ display:"flex", alignItems:"center", padding:"11px 16px", borderBottom: i<WIDGETS.length-1?`1px solid ${C.border2}`:"none", cursor:"pointer", background: enabled?"rgba(170,255,0,.04)":"transparent" }}
                        onClick={()=>toggleWidget(w.url)}>
                        {/* toggle */}
                        <div style={{ width:32, height:18, borderRadius:99, background: enabled?C.lime:"rgba(255,255,255,.1)", position:"relative", flexShrink:0, transition:"background .2s" }}>
                          <div style={{ position:"absolute", top:3, left: enabled?15:3, width:12, height:12, borderRadius:"50%", background: enabled?"#111":"rgba(255,255,255,.4)", transition:"left .2s" }}/>
                        </div>
                        <div style={{ marginLeft:12, flex:1 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                            <span style={{ fontSize:13, fontWeight:700, color: enabled?C.text:"rgba(255,255,255,.4)" }}>{w.label}</span>
                            <span style={s.badge(w.tier==="base"?"lime":"amber")}>{w.tier}</span>
                            {missingDBs.length>0 && enabled && <span style={s.badge("red")}>missing DBs</span>}
                          </div>
                          <div style={{ fontSize:10, color:C.textDim, marginTop:1 }}>{w.url}</div>
                        </div>
                        <span style={{ fontSize:11, fontWeight:700, color: enabled?C.lime:C.textDim }}>{enabled?"On":"Off"}</span>
                      </div>
                    )
                  })}
                </div>
                <div style={{ fontSize:10, color:C.textDim, marginBottom:4 }}>Enabled widgets appear highlighted in Widget URLs. Add-on widgets are ones sold separately.</div>

                {/* ── Notion ── */}
                <span style={s.secLabel}>Notion<span style={s.secNote}>— client's own integration key (preferred) or leave blank to use Opxio shared key</span></span>
                <div style={s.fieldWrap}>
                  <label style={s.lbl}>API Token</label>
                  <input style={s.input} value={form.notion_token} onChange={e=>setForm(f=>({...f,notion_token:e.target.value}))} placeholder="ntn_..." />
                </div>

                {/* ── DB IDs ── */}
                {Object.entries(DB_GROUPS).map(([group, keys]) => (
                  <div key={group}>
                    <span style={s.secLabel}>{group} — DB IDs<span style={s.secNote}>blank = skip / use Opxio default</span></span>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                      {keys.map(key => (
                        <div key={key} style={s.fieldWrap}>
                          <label style={s.lbl}>{key}</label>
                          <input style={s.input} value={form.databases[key]||""} onChange={e=>setDB(key,e.target.value)} placeholder="notion db id…" />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {/* ── Field Mappings ── */}
                <span style={s.secLabel}>Field Mappings<span style={s.secNote}>— only fill if client uses different field names in Notion</span></span>

                {/* CRM + Deals */}
                <div style={{ fontSize:10, fontWeight:700, color:"rgba(170,255,0,.5)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>CRM &amp; Deals — Stage field</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>STAGE_FIELD<span style={{ ...s.secNote, fontSize:10 }}> default: Stage</span></label>
                    <input style={s.input} value={form.field_map.STAGE_FIELD||""} onChange={e=>setFM("STAGE_FIELD",e.target.value)} placeholder="Stage" />
                  </div>
                </div>

                {/* Projects */}
                <div style={{ fontSize:10, fontWeight:700, color:"rgba(170,255,0,.5)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>Projects widget</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>STATUS_FIELD<span style={{ ...s.secNote, fontSize:10 }}> default: Status</span></label>
                    <input style={s.input} value={form.field_map.STATUS_FIELD||""} onChange={e=>setFM("STATUS_FIELD",e.target.value)} placeholder="Status" />
                  </div>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>PACKAGE_FIELD<span style={{ ...s.secNote, fontSize:10 }}> default: Package Type</span></label>
                    <input style={s.input} value={form.field_map.PACKAGE_FIELD||""} onChange={e=>setFM("PACKAGE_FIELD",e.target.value)} placeholder="Package Type" />
                  </div>
                </div>

                {/* Meetings */}
                <div style={{ fontSize:10, fontWeight:700, color:"rgba(170,255,0,.5)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>Schedule / Meetings widget</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>TYPE_FIELD<span style={{ ...s.secNote, fontSize:10 }}> default: Type</span></label>
                    <input style={s.input} value={form.field_map.TYPE_FIELD||""} onChange={e=>setFM("TYPE_FIELD",e.target.value)} placeholder="Type" />
                  </div>
                </div>

                {/* Finance */}
                <div style={{ fontSize:10, fontWeight:700, color:"rgba(170,255,0,.5)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>Finance widget</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
                  <div style={s.fieldWrap}>
                    <label style={s.lbl}>INVOICE_TYPE_FIELD<span style={{ ...s.secNote, fontSize:10 }}> default: Invoice Type</span></label>
                    <input style={s.input} value={form.field_map.INVOICE_TYPE_FIELD||""} onChange={e=>setFM("INVOICE_TYPE_FIELD",e.target.value)} placeholder="Invoice Type" />
                  </div>
                </div>

                {/* Pipeline stages */}
                <div style={{ fontSize:10, fontWeight:700, color:"rgba(170,255,0,.5)", textTransform:"uppercase", letterSpacing:".08em", marginBottom:8 }}>CRM Pipeline — stage order</div>
                <div style={s.fieldWrap}>
                  <label style={s.lbl}>All Stages<span style={{ ...s.secNote, fontSize:10 }}> comma-separated — last two = won / lost</span></label>
                  <input style={s.input} value={form.labels.stages||""} onChange={e=>setLbl("stages",e.target.value)} placeholder="Lead, Contacted, Qualified, Closed-Won, Closed-Lost" />
                </div>
                <div style={s.fieldWrap}>
                  <label style={s.lbl}>Active Stages<span style={{ ...s.secNote, fontSize:10 }}> pre-close stages shown on funnel board</span></label>
                  <input style={s.input} value={form.labels.activeStages||""} onChange={e=>setLbl("activeStages",e.target.value)} placeholder="Lead, Contacted, Qualified" />
                </div>

                {/* ── Access token ── */}
                <span style={s.secLabel}>Access Token</span>
                {form.access_token ? (<>
                  <div style={s.tokenBox} onClick={()=>copy(form.access_token)}>
                    {form.access_token} <span style={{ opacity:.4, fontSize:9 }}>click to copy</span>
                  </div>
                  {selected!=="__new__" && (
                    <button style={{ ...s.dangerBtn, fontSize:11 }} onClick={regenToken}>↻ Regenerate Token</button>
                  )}
                  <div style={{ fontSize:10, color:C.textDim, marginTop:6 }}>Regenerating immediately invalidates the current token for this client.</div>
                </>) : (
                  <div style={{ fontSize:12, color:C.textDim, marginBottom:12 }}>Auto-generated on save.</div>
                )}

                {/* ── Actions ── */}
                <div style={{ marginTop:28, paddingTop:20, borderTop:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:8 }}>
                  <button style={s.saveBtn} onClick={save} disabled={saving}>{saving?"Saving…":selected==="__new__"?"Create Client":"Save Changes"}</button>
                  <button style={s.ghostBtn} onClick={()=>setSelected(null)}>Cancel</button>
                  {selected!=="__new__" && <button style={{ ...s.copyBtn, marginLeft:"auto" }} onClick={()=>setWidgetModal(selected)}>View Widget URLs →</button>}
                </div>

              </div>
            )}
          </div>

        </div>
      </div>
    </>
  )
}
