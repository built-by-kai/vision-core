"""
implementation_form.py
GET  /api/implementation_form?c=COMPANY_ID&pkg=PACKAGE
     → Serves a branded intake form tailored to the purchased OS package
POST /api/implementation_form?c=COMPANY_ID&pkg=PACKAGE
     → Submits responses, creates a rich Implementation page in Notion

PACKAGE slugs: workflow-os | sales-crm | full-agency-os | complete-os |
               revenue-os  | modular-os | custom-os
"""
import json
import os
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

# ─────────────────────────────────────────────
#  Config
# ─────────────────────────────────────────────
IMPL_DB = "c1dfe60097f682f1b0f10142af6449d0"   # Client Implementation

PKG_LABELS = {
    "workflow-os":    "Workflow OS",
    "sales-crm":      "Sales CRM",
    "full-agency-os": "Full Agency OS",
    "complete-os":    "Complete OS",
    "revenue-os":     "Revenue OS",
    "modular-os":     "Modular OS",
    "custom-os":      "Custom OS",
}
PKG_DESC = {
    "workflow-os":    "We'll be mapping and automating your core business workflows.",
    "sales-crm":      "We'll be building your sales pipeline, lead tracking, and CRM.",
    "full-agency-os": "We'll be building your complete agency operating system.",
    "complete-os":    "We'll be building your complete business operating system.",
    "revenue-os":     "We'll be building your revenue tracking and financial OS.",
    "modular-os":     "We'll be building selected modules for your operating system.",
    "custom-os":      "We'll be building a fully customised operating system for your team.",
}


# ─────────────────────────────────────────────
#  Notion helpers
# ─────────────────────────────────────────────
def notion_headers():
    return {
        "Authorization":  f"Bearer {os.environ.get('NOTION_API_KEY', '')}",
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
    }


def get_company(company_id, hdrs):
    r = requests.get(f"https://api.notion.com/v1/pages/{company_id}", headers=hdrs, timeout=10)
    if not r.ok:
        return None
    props = r.json().get("properties", {})
    title_arr = (props.get("Company") or props.get("Name") or {}).get("title", [])
    name = "".join(t.get("plain_text", "") for t in title_arr)
    return {"id": company_id, "name": name or "Your Company"}


def _rt(text):
    """Notion rich_text block helper."""
    return [{"text": {"content": text[:2000]}}]


def _h2(text):
    return {"object": "block", "type": "heading_2",
            "heading_2": {"rich_text": _rt(text), "color": "default"}}


def _h3(text):
    return {"object": "block", "type": "heading_3",
            "heading_3": {"rich_text": _rt(text), "color": "default"}}


def _p(text):
    return {"object": "block", "type": "paragraph",
            "paragraph": {"rich_text": _rt(text) if text else []}}


def _div():
    return {"object": "block", "type": "divider", "divider": {}}


# ─────────────────────────────────────────────
#  Package-specific form sections (HTML)
# ─────────────────────────────────────────────
def pkg_section_html(pkg_slug):
    if pkg_slug == "sales-crm":
        return """
        <div class="field">
          <label>How do you currently track leads and deals?</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="crm_current" value="Excel / Spreadsheet"> Excel / Sheet</label>
            <label class="radio-item"><input type="radio" name="crm_current" value="Existing CRM (see tools)"> Existing CRM</label>
            <label class="radio-item"><input type="radio" name="crm_current" value="WhatsApp / chat"> WhatsApp / chat</label>
            <label class="radio-item"><input type="radio" name="crm_current" value="No system"> No system</label>
          </div>
        </div>
        <div class="field">
          <label>What are your main lead sources?</label>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="lead_sources" value="Instagram"> Instagram</label>
            <label class="check-item"><input type="checkbox" name="lead_sources" value="LinkedIn"> LinkedIn</label>
            <label class="check-item"><input type="checkbox" name="lead_sources" value="Threads"> Threads</label>
            <label class="check-item"><input type="checkbox" name="lead_sources" value="Referrals"> Referrals</label>
            <label class="check-item"><input type="checkbox" name="lead_sources" value="Cold outreach"> Cold outreach</label>
            <label class="check-item"><input type="checkbox" name="lead_sources" value="Website enquiry"> Website enquiry</label>
            <label class="check-item"><input type="checkbox" name="lead_sources" value="Events"> Events</label>
            <label class="check-item"><input type="checkbox" name="lead_sources" value="Walk-in"> Walk-in</label>
          </div>
        </div>
        <div class="field">
          <label>What stages does a deal go through before closing?</label>
          <p class="hint">Describe your pipeline (e.g. New Lead → Contacted → Proposal Sent → Negotiation → Won/Lost)</p>
          <textarea name="pipeline_stages" rows="3" placeholder="Stage 1 → Stage 2 → …"></textarea>
        </div>
        <div class="field">
          <label>What metrics do you want to track?</label>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="crm_metrics" value="Total pipeline value"> Pipeline value</label>
            <label class="check-item"><input type="checkbox" name="crm_metrics" value="Conversion rate"> Conversion rate</label>
            <label class="check-item"><input type="checkbox" name="crm_metrics" value="Monthly revenue"> Monthly revenue</label>
            <label class="check-item"><input type="checkbox" name="crm_metrics" value="Follow-up due dates"> Follow-up dates</label>
            <label class="check-item"><input type="checkbox" name="crm_metrics" value="Deals per salesperson"> Deals per person</label>
            <label class="check-item"><input type="checkbox" name="crm_metrics" value="Lead source performance"> Source performance</label>
          </div>
        </div>
        <div class="field">
          <label>Roughly how many active deals does your team manage at any time?</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="deal_volume" value="< 10"> &lt; 10</label>
            <label class="radio-item"><input type="radio" name="deal_volume" value="10–30"> 10–30</label>
            <label class="radio-item"><input type="radio" name="deal_volume" value="30–100"> 30–100</label>
            <label class="radio-item"><input type="radio" name="deal_volume" value="> 100"> &gt; 100</label>
          </div>
        </div>
"""
    elif pkg_slug == "workflow-os":
        return """
        <div class="field">
          <label>List your top 3–5 recurring workflows or processes</label>
          <p class="hint">One per line. Be specific — e.g. "Client onboarding", "Monthly payroll", "Content approval"</p>
          <textarea name="top_workflows" rows="6" placeholder="1. Client onboarding&#10;2. Invoice & payment follow-up&#10;3. Weekly reporting&#10;4. Staff leave approval&#10;5. …"></textarea>
        </div>
        <div class="field">
          <label>Which workflows have the most friction or cause the most errors right now?</label>
          <textarea name="pain_workflows" rows="3" placeholder="e.g. Onboarding takes too long, things get missed between handoffs…"></textarea>
        </div>
        <div class="field">
          <label>How are tasks and responsibilities currently assigned?</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="task_assign" value="WhatsApp / chat"> WhatsApp / chat</label>
            <label class="radio-item"><input type="radio" name="task_assign" value="Verbal / meetings"> Verbal / meeting</label>
            <label class="radio-item"><input type="radio" name="task_assign" value="Email"> Email</label>
            <label class="radio-item"><input type="radio" name="task_assign" value="Project tool"> Project tool</label>
          </div>
        </div>
        <div class="field">
          <label>Do workflows require approvals? If so, who approves?</label>
          <textarea name="approvals" rows="2" placeholder="e.g. All expenses above RM500 need director approval, designs need client sign-off…"></textarea>
        </div>
        <div class="field">
          <label>Do you have existing SOPs or process docs?</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="has_sops" value="No"> No, starting fresh</label>
            <label class="radio-item"><input type="radio" name="has_sops" value="Yes – Google Docs"> Yes – Google Docs</label>
            <label class="radio-item"><input type="radio" name="has_sops" value="Yes – Word/PDF"> Yes – Word / PDF</label>
            <label class="radio-item"><input type="radio" name="has_sops" value="Yes – verbal only"> Yes – verbal only</label>
          </div>
        </div>
        <div class="field">
          <label>Links to any existing SOPs <span style="font-weight:400;color:#aaa">(optional)</span></label>
          <input type="text" name="sop_links" placeholder="Google Drive, Dropbox, Notion page…">
        </div>
"""
    elif pkg_slug in ("full-agency-os", "complete-os"):
        return """
        <div class="field">
          <label>What types of projects / services do you deliver to clients?</label>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="service_types" value="Social media management"> Social media</label>
            <label class="check-item"><input type="checkbox" name="service_types" value="Graphic design"> Graphic design</label>
            <label class="check-item"><input type="checkbox" name="service_types" value="Video production"> Video</label>
            <label class="check-item"><input type="checkbox" name="service_types" value="Website / web design"> Website</label>
            <label class="check-item"><input type="checkbox" name="service_types" value="Copywriting / content"> Copywriting</label>
            <label class="check-item"><input type="checkbox" name="service_types" value="PR / media"> PR / media</label>
            <label class="check-item"><input type="checkbox" name="service_types" value="Events"> Events</label>
            <label class="check-item"><input type="checkbox" name="service_types" value="Consulting / strategy"> Consulting</label>
          </div>
        </div>
        <div class="field">
          <label>How do you currently manage project delivery?</label>
          <textarea name="delivery_mgmt" rows="3" placeholder="e.g. Each project has a team lead, we use WhatsApp groups per client, deadlines tracked in Excel…"></textarea>
        </div>
        <div class="field">
          <label>How do clients give feedback or approve deliverables?</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="client_feedback" value="WhatsApp"> WhatsApp</label>
            <label class="radio-item"><input type="radio" name="client_feedback" value="Email"> Email</label>
            <label class="radio-item"><input type="radio" name="client_feedback" value="Review portal"> Review portal</label>
            <label class="radio-item"><input type="radio" name="client_feedback" value="Meeting / call"> Meeting / call</label>
          </div>
        </div>
        <div class="field">
          <label>Client engagement model</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="engagement_model" value="Mostly retainer"> Mostly retainer</label>
            <label class="radio-item"><input type="radio" name="engagement_model" value="Mostly project-based"> Mostly project</label>
            <label class="radio-item"><input type="radio" name="engagement_model" value="Mix of both"> Mix of both</label>
          </div>
        </div>
        <div class="field">
          <label>Do you need team capacity / workload tracking?</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="capacity_tracking" value="Yes – essential"> Yes, essential</label>
            <label class="radio-item"><input type="radio" name="capacity_tracking" value="Yes – nice to have"> Nice to have</label>
            <label class="radio-item"><input type="radio" name="capacity_tracking" value="No"> Not needed</label>
          </div>
        </div>
        <div class="field">
          <label>What are your top 3 operational pain points right now?</label>
          <textarea name="pain_points" rows="4" placeholder="e.g. Missing deadlines, no visibility on who's working on what, client revisions go on forever…"></textarea>
        </div>
"""
    elif pkg_slug == "revenue-os":
        return """
        <div class="field">
          <label>What are your main revenue streams?</label>
          <textarea name="revenue_streams" rows="3" placeholder="e.g. Monthly retainers, one-off projects, product sales, commissions…"></textarea>
        </div>
        <div class="field">
          <label>How do you currently track revenue and invoices?</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="revenue_tracking" value="Excel / Sheets"> Excel / Sheet</label>
            <label class="radio-item"><input type="radio" name="revenue_tracking" value="Accounting software"> Accounting software</label>
            <label class="radio-item"><input type="radio" name="revenue_tracking" value="WhatsApp / manual"> Manual / WhatsApp</label>
            <label class="radio-item"><input type="radio" name="revenue_tracking" value="No system"> No system</label>
          </div>
        </div>
        <div class="field">
          <label>Do you need revenue forecasting / projections?</label>
          <div class="radio-group">
            <label class="radio-item"><input type="radio" name="forecasting" value="Yes – monthly"> Yes – monthly</label>
            <label class="radio-item"><input type="radio" name="forecasting" value="Yes – quarterly"> Yes – quarterly</label>
            <label class="radio-item"><input type="radio" name="forecasting" value="No"> Not needed</label>
          </div>
        </div>
        <div class="field">
          <label>What financial metrics are most important to you?</label>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="fin_metrics" value="Monthly recurring revenue"> Monthly MRR</label>
            <label class="check-item"><input type="checkbox" name="fin_metrics" value="Outstanding invoices"> Outstanding invoices</label>
            <label class="check-item"><input type="checkbox" name="fin_metrics" value="Expenses vs revenue"> Expenses vs revenue</label>
            <label class="check-item"><input type="checkbox" name="fin_metrics" value="Revenue per client"> Revenue per client</label>
            <label class="check-item"><input type="checkbox" name="fin_metrics" value="Profit margin"> Profit margin</label>
            <label class="check-item"><input type="checkbox" name="fin_metrics" value="Cash flow"> Cash flow</label>
          </div>
        </div>
"""
    else:
        # modular-os, custom-os or unknown
        return """
        <div class="field">
          <label>Which areas of the business do you want your OS to cover?</label>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="os_modules" value="CRM / Sales pipeline"> CRM / Sales</label>
            <label class="check-item"><input type="checkbox" name="os_modules" value="Client management"> Client management</label>
            <label class="check-item"><input type="checkbox" name="os_modules" value="Project management"> Project management</label>
            <label class="check-item"><input type="checkbox" name="os_modules" value="Finance / invoicing"> Finance / invoicing</label>
            <label class="check-item"><input type="checkbox" name="os_modules" value="HR / team management"> HR / team</label>
            <label class="check-item"><input type="checkbox" name="os_modules" value="Content / creative"> Content / creative</label>
            <label class="check-item"><input type="checkbox" name="os_modules" value="SOPs / knowledge base"> SOPs / knowledge</label>
            <label class="check-item"><input type="checkbox" name="os_modules" value="Reporting / dashboards"> Reporting</label>
          </div>
        </div>
        <div class="field">
          <label>What is the #1 thing you want to fix or improve with this build?</label>
          <textarea name="top_priority" rows="3" placeholder="Be as specific as possible…"></textarea>
        </div>
        <div class="field">
          <label>Are there specific features or views you already have in mind?</label>
          <textarea name="specific_requests" rows="3" placeholder="e.g. I want a Kanban board for my team tasks, a client portal view, a weekly dashboard…"></textarea>
        </div>
"""


# ─────────────────────────────────────────────
#  HTML Form renderer
# ─────────────────────────────────────────────
def render_form(company_name, company_id, pkg_slug, error=None):
    pkg_label = PKG_LABELS.get(pkg_slug, "Implementation")
    pkg_desc  = PKG_DESC.get(pkg_slug, "We'll be setting up your Notion OS.")
    pkg_sec   = pkg_section_html(pkg_slug)
    err_html  = f'<div class="error">{error}</div>' if error else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Implementation Intake — {company_name}</title>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f5; color: #1a1a1a; min-height: 100vh; }}
  .shell {{ display: flex; min-height: 100vh; }}

  .sidebar {{ width: 240px; background: #1a1a1a; color: #fff; padding: 40px 28px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }}
  .sidebar .logo {{ font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #555; margin-bottom: 6px; }}
  .sidebar .co-name {{ font-size: 18px; font-weight: 700; line-height: 1.3; margin-bottom: 4px; }}
  .sidebar .pkg-badge {{ display: inline-block; font-size: 11px; font-weight: 600; color: #888; background: #2a2a2a; padding: 3px 8px; border-radius: 20px; margin-bottom: 32px; }}
  .nav-item {{ display: flex; align-items: center; gap: 10px; padding: 9px 0; font-size: 13px; color: #555; cursor: pointer; transition: color .2s; border: none; background: none; width: 100%; text-align: left; }}
  .nav-item.active {{ color: #fff; }}
  .nav-item.done {{ color: #444; }}
  .nav-dot {{ width: 7px; height: 7px; border-radius: 50%; background: #333; flex-shrink: 0; transition: background .2s; }}
  .nav-item.active .nav-dot {{ background: #fff; box-shadow: 0 0 0 3px #444; }}
  .nav-item.done .nav-dot {{ background: #555; }}

  .main {{ flex: 1; padding: 48px 56px; max-width: 720px; }}
  .section {{ display: none; }}
  .section.active {{ display: block; animation: fadeIn .2s ease; }}
  @keyframes fadeIn {{ from {{ opacity:0; transform:translateY(6px) }} to {{ opacity:1; transform:translateY(0) }} }}

  .section-tag {{ font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #bbb; margin-bottom: 8px; }}
  .section-title {{ font-size: 26px; font-weight: 700; margin-bottom: 6px; }}
  .section-desc {{ font-size: 14px; color: #666; line-height: 1.6; margin-bottom: 36px; }}

  .field {{ margin-bottom: 24px; }}
  .field > label {{ display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }}
  .hint {{ font-size: 12px; color: #aaa; margin-bottom: 6px; }}
  .field input[type=text], .field input[type=url], .field input[type=date], .field textarea, .field select {{
    width: 100%; padding: 10px 14px; border: 1.5px solid #e0e0e0; border-radius: 8px;
    font-size: 14px; color: #1a1a1a; background: #fff; outline: none;
    transition: border-color .2s; font-family: inherit; }}
  .field input:focus, .field textarea:focus {{ border-color: #1a1a1a; }}
  .field textarea {{ resize: vertical; min-height: 96px; line-height: 1.6; }}

  .color-row {{ display: flex; gap: 10px; }}
  .color-item {{ flex: 1; }}
  .color-item > label {{ font-size: 12px; font-weight: 500; color: #666; display: block; margin-bottom: 5px; }}
  .color-wrap {{ display: flex; align-items: center; gap: 8px; border: 1.5px solid #e0e0e0; border-radius: 8px; padding: 8px 12px; background: #fff; }}
  .color-wrap input[type=color] {{ width: 28px; height: 28px; border: none; padding: 0; cursor: pointer; background: none; border-radius: 4px; }}
  .color-wrap input[type=text] {{ border: none; padding: 0; font-size: 13px; width: 80px; outline: none; font-family: monospace; }}

  .check-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 7px; margin-top: 4px; }}
  .check-item {{ display: flex; align-items: center; gap: 8px; padding: 9px 12px; border: 1.5px solid #e0e0e0; border-radius: 8px; cursor: pointer; font-size: 13px; background: #fff; transition: border-color .15s, background .15s; user-select: none; }}
  .check-item:hover {{ border-color: #bbb; }}
  .check-item input[type=checkbox] {{ width: 15px; height: 15px; accent-color: #1a1a1a; cursor: pointer; flex-shrink: 0; }}
  .check-item.checked {{ border-color: #1a1a1a; background: #f5f5f3; font-weight: 500; }}

  .cat-label {{ font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #aaa; margin: 20px 0 8px; }}

  .radio-group {{ display: flex; gap: 7px; flex-wrap: wrap; margin-top: 4px; }}
  .radio-item {{ display: flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1.5px solid #e0e0e0; border-radius: 20px; cursor: pointer; font-size: 13px; background: #fff; transition: all .15s; user-select: none; }}
  .radio-item input {{ display: none; }}
  .radio-item.selected {{ border-color: #1a1a1a; background: #1a1a1a; color: #fff; }}

  .nav-btns {{ display: flex; justify-content: space-between; margin-top: 40px; padding-top: 24px; border-top: 1px solid #ebebeb; }}
  .btn {{ padding: 11px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: opacity .2s; }}
  .btn:hover {{ opacity: .8; }}
  .btn-back {{ background: #fff; border: 1.5px solid #e0e0e0; color: #1a1a1a; }}
  .btn-next {{ background: #1a1a1a; color: #fff; margin-left: auto; }}
  .btn-submit {{ background: #1a1a1a; color: #fff; margin-left: auto; min-width: 160px; }}

  .progress-bar {{ height: 3px; background: #ebebeb; border-radius: 2px; margin-bottom: 40px; }}
  .progress-fill {{ height: 100%; background: #1a1a1a; border-radius: 2px; transition: width .3s ease; }}
  .error {{ background: #fff0f0; border: 1px solid #ffcccc; color: #cc0000; padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 24px; }}

  @media (max-width: 680px) {{
    .sidebar {{ display: none; }}
    .main {{ padding: 28px 18px; }}
    .color-row {{ flex-direction: column; }}
    .section-title {{ font-size: 22px; }}
  }}
</style>
</head>
<body>
<div class="shell">
  <nav class="sidebar">
    <div class="logo">Vision Core</div>
    <div class="co-name">{company_name}</div>
    <div class="pkg-badge">{pkg_label}</div>
    <button class="nav-item active" onclick="goTo(0)"><span class="nav-dot"></span>Brand Identity</button>
    <button class="nav-item" onclick="goTo(1)"><span class="nav-dot"></span>Current Tech Stack</button>
    <button class="nav-item" onclick="goTo(2)"><span class="nav-dot"></span>Team & Access</button>
    <button class="nav-item" onclick="goTo(3)"><span class="nav-dot"></span>{pkg_label} Details</button>
    <button class="nav-item" onclick="goTo(4)"><span class="nav-dot"></span>Timeline & Notes</button>
  </nav>

  <main class="main">
    {err_html}
    <div class="progress-bar"><div class="progress-fill" id="progress" style="width:20%"></div></div>

    <form method="POST" action="/api/implementation_form?c={company_id}&pkg={pkg_slug}" id="form">
      <input type="hidden" name="company_id" value="{company_id}">
      <input type="hidden" name="pkg_slug" value="{pkg_slug}">

      <!-- 01 Brand -->
      <div class="section active" id="s0">
        <div class="section-tag">01 / 05  ·  Brand Identity</div>
        <h1 class="section-title">Let's start with your brand.</h1>
        <p class="section-desc">This helps us style your Notion OS to match your identity — fonts, colours, logo.</p>
        <div class="field">
          <label>Company logo URL <span style="font-weight:400;color:#aaa">(optional)</span></label>
          <p class="hint">Paste a direct link — Google Drive (shared), Dropbox, or your website.</p>
          <input type="url" name="logo_url" placeholder="https://…">
        </div>
        <div class="field">
          <label>Brand colours</label>
          <div class="color-row">
            <div class="color-item"><label>Primary</label>
              <div class="color-wrap"><input type="color" id="c1" value="#1a1a1a" oninput="document.getElementById('c1t').value=this.value"><input type="text" id="c1t" name="primary_color" value="#1a1a1a" maxlength="7" oninput="syncColor(this,'c1')"></div></div>
            <div class="color-item"><label>Secondary</label>
              <div class="color-wrap"><input type="color" id="c2" value="#ffffff" oninput="document.getElementById('c2t').value=this.value"><input type="text" id="c2t" name="secondary_color" value="#ffffff" maxlength="7" oninput="syncColor(this,'c2')"></div></div>
            <div class="color-item"><label>Accent</label>
              <div class="color-wrap"><input type="color" id="c3" value="#888888" oninput="document.getElementById('c3t').value=this.value"><input type="text" id="c3t" name="accent_color" value="#888888" maxlength="7" oninput="syncColor(this,'c3')"></div></div>
          </div>
        </div>
        <div class="field">
          <label>Typography / fonts used</label>
          <p class="hint">What fonts represent your brand? (e.g. Neue Montreal for headings, Inter for body)</p>
          <input type="text" name="fonts" placeholder="Heading font, body font…">
        </div>
        <div class="nav-btns"><button type="button" class="btn btn-next" onclick="goTo(1)">Continue →</button></div>
      </div>

      <!-- 02 Tools -->
      <div class="section" id="s1">
        <div class="section-tag">02 / 05  ·  Current Tech Stack</div>
        <h1 class="section-title">What tools is your team using?</h1>
        <p class="section-desc">Tick everything your company currently uses. Don't overthink it — even if it's just Excel and WhatsApp, that's useful info.</p>

        <div class="cat-label">CRM / Sales</div>
        <div class="check-grid">
          <label class="check-item"><input type="checkbox" name="tools" value="Salesforce"> Salesforce</label>
          <label class="check-item"><input type="checkbox" name="tools" value="HubSpot"> HubSpot</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Pipedrive"> Pipedrive</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Excel/Sheets CRM"> Excel / Sheets</label>
        </div>
        <div class="cat-label">Project Management</div>
        <div class="check-grid">
          <label class="check-item"><input type="checkbox" name="tools" value="Asana"> Asana</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Monday.com"> Monday.com</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Trello"> Trello</label>
          <label class="check-item"><input type="checkbox" name="tools" value="ClickUp"> ClickUp</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Notion (existing)"> Notion (existing)</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Jira"> Jira</label>
        </div>
        <div class="cat-label">Communication</div>
        <div class="check-grid">
          <label class="check-item"><input type="checkbox" name="tools" value="Slack"> Slack</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Microsoft Teams"> MS Teams</label>
          <label class="check-item"><input type="checkbox" name="tools" value="WhatsApp Business"> WhatsApp Biz</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Telegram"> Telegram</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Lark"> Lark</label>
        </div>
        <div class="cat-label">Finance</div>
        <div class="check-grid">
          <label class="check-item"><input type="checkbox" name="tools" value="Xero"> Xero</label>
          <label class="check-item"><input type="checkbox" name="tools" value="QuickBooks"> QuickBooks</label>
          <label class="check-item"><input type="checkbox" name="tools" value="SQL Acc"> SQL Acc</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Excel/Sheets Finance"> Excel / Sheets</label>
        </div>
        <div class="cat-label">Design & Storage</div>
        <div class="check-grid">
          <label class="check-item"><input type="checkbox" name="tools" value="Canva"> Canva</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Adobe Suite"> Adobe Suite</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Figma"> Figma</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Google Drive"> Google Drive</label>
          <label class="check-item"><input type="checkbox" name="tools" value="Dropbox"> Dropbox</label>
          <label class="check-item"><input type="checkbox" name="tools" value="OneDrive"> OneDrive</label>
        </div>
        <div class="field" style="margin-top:20px">
          <label>Any other tools not listed above?</label>
          <input type="text" name="tools_other" placeholder="e.g. CapCut, DingTalk, Lark, Miro…">
        </div>
        <div class="nav-btns">
          <button type="button" class="btn btn-back" onclick="goTo(0)">← Back</button>
          <button type="button" class="btn btn-next" onclick="goTo(2)">Continue →</button>
        </div>
      </div>

      <!-- 03 Team -->
      <div class="section" id="s2">
        <div class="section-tag">03 / 05  ·  Team & Access</div>
        <h1 class="section-title">Tell us about your team.</h1>
        <p class="section-desc">We'll use this to set up the right dashboards, permission levels, and team views.</p>

        <div class="field">
          <label>Which departments / teams exist in your company?</label>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="depts" value="Leadership"> Leadership</label>
            <label class="check-item"><input type="checkbox" name="depts" value="Sales"> Sales</label>
            <label class="check-item"><input type="checkbox" name="depts" value="Marketing"> Marketing</label>
            <label class="check-item"><input type="checkbox" name="depts" value="Operations"> Operations</label>
            <label class="check-item"><input type="checkbox" name="depts" value="Finance"> Finance</label>
            <label class="check-item"><input type="checkbox" name="depts" value="HR"> HR</label>
            <label class="check-item"><input type="checkbox" name="depts" value="Tech / IT"> Tech / IT</label>
            <label class="check-item"><input type="checkbox" name="depts" value="Creative"> Creative</label>
            <label class="check-item"><input type="checkbox" name="depts" value="Customer Success"> Customer Success</label>
            <label class="check-item"><input type="checkbox" name="depts" value="Admin"> Admin</label>
          </div>
        </div>
        <div class="field">
          <label>Who will be using the Notion OS day-to-day?</label>
          <textarea name="notion_users" rows="2" placeholder="e.g. Entire team (8 pax), just the leadership team, ops + sales only…"></textarea>
        </div>
        <div class="field">
          <label>Current Notion experience level of your team</label>
          <div class="radio-group" id="rg-level">
            <label class="radio-item"><input type="radio" name="notion_level" value="None"> None at all</label>
            <label class="radio-item"><input type="radio" name="notion_level" value="Basic"> Familiar (used before)</label>
            <label class="radio-item"><input type="radio" name="notion_level" value="Intermediate"> Comfortable</label>
            <label class="radio-item"><input type="radio" name="notion_level" value="Advanced"> Power users</label>
          </div>
        </div>
        <div class="field">
          <label>Existing Notion workspace?</label>
          <div class="radio-group" id="rg-notion">
            <label class="radio-item"><input type="radio" name="has_notion" value="No"> No, starting fresh</label>
            <label class="radio-item"><input type="radio" name="has_notion" value="Yes – barely used"> Yes – barely used</label>
            <label class="radio-item"><input type="radio" name="has_notion" value="Yes – active"> Yes – actively used</label>
          </div>
        </div>
        <div class="nav-btns">
          <button type="button" class="btn btn-back" onclick="goTo(1)">← Back</button>
          <button type="button" class="btn btn-next" onclick="goTo(3)">Continue →</button>
        </div>
      </div>

      <!-- 04 Package-specific -->
      <div class="section" id="s3">
        <div class="section-tag">04 / 05  ·  {pkg_label}</div>
        <h1 class="section-title">Now the build-specific details.</h1>
        <p class="section-desc">{pkg_desc} These answers directly shape what we build.</p>
        {pkg_sec}
        <div class="nav-btns">
          <button type="button" class="btn btn-back" onclick="goTo(2)">← Back</button>
          <button type="button" class="btn btn-next" onclick="goTo(4)">Continue →</button>
        </div>
      </div>

      <!-- 05 Timeline -->
      <div class="section" id="s4">
        <div class="section-tag">05 / 05  ·  Timeline & Notes</div>
        <h1 class="section-title">Almost done.</h1>
        <p class="section-desc">Last few details so we can plan your build schedule.</p>
        <div class="field">
          <label>Preferred build start date <span style="font-weight:400;color:#aaa">(optional)</span></label>
          <input type="date" name="preferred_start">
        </div>
        <div class="field">
          <label>Is there a deadline or go-live date to work towards?</label>
          <input type="text" name="deadline" placeholder="e.g. Before end of May, before Raya, no rush…">
        </div>
        <div class="field">
          <label>Anything else we should know before we start?</label>
          <textarea name="extra_notes" rows="4" placeholder="Any concerns, must-haves, access details, or context that didn't fit above…"></textarea>
        </div>
        <div class="nav-btns">
          <button type="button" class="btn btn-back" onclick="goTo(3)">← Back</button>
          <button type="submit" class="btn btn-submit">Submit Intake ✓</button>
        </div>
      </div>

    </form>
  </main>
</div>
<script>
  let cur = 0;
  const total = 5;
  document.querySelectorAll('.check-item input').forEach(cb => {{
    cb.addEventListener('change', () => cb.closest('.check-item').classList.toggle('checked', cb.checked));
  }});
  document.querySelectorAll('[id^="rg-"],.radio-group').forEach(group => {{
    group.querySelectorAll('.radio-item').forEach(item => {{
      item.addEventListener('click', () => {{
        group.querySelectorAll('.radio-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
      }});
    }});
  }});
  function syncColor(el, id) {{
    if (/^#[0-9a-fA-F]{{6}}$/.test(el.value)) document.getElementById(id).value = el.value;
  }}
  function goTo(idx) {{
    document.querySelectorAll('.section').forEach((s,i) => s.classList.toggle('active', i===idx));
    document.querySelectorAll('.nav-item').forEach((n,i) => {{
      n.classList.remove('active','done');
      if(i===idx) n.classList.add('active');
      else if(i<idx) n.classList.add('done');
    }});
    document.getElementById('progress').style.width = ((idx+1)/total*100)+'%';
    cur = idx;
    window.scrollTo(0,0);
  }}
</script>
</body>
</html>"""


def render_success(company_name):
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Submitted</title>
<style>body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f5;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}}
.card{{background:#fff;border-radius:16px;padding:56px 48px;max-width:460px;width:90%;text-align:center;
box-shadow:0 2px 24px rgba(0,0,0,.06);}}
.icon{{font-size:44px;margin-bottom:20px;}}
h1{{font-size:24px;font-weight:700;margin-bottom:12px;}}
p{{font-size:14px;color:#666;line-height:1.7;}}
.co{{font-weight:600;color:#1a1a1a;}}</style></head>
<body><div class="card">
<div class="icon">✅</div>
<h1>Intake submitted!</h1>
<p>Thanks, <span class="co">{company_name}</span>.<br>We've received all your details and will review them before your build kicks off.<br><br>We'll be in touch shortly to confirm your schedule.</p>
</div></body></html>"""


# ─────────────────────────────────────────────
#  Notion page body builder
# ─────────────────────────────────────────────
def build_page_body(data, pkg_slug, pkg_label):
    """Return a list of Notion blocks representing the structured intake responses."""

    def g(key): return (data.get(key) or [""])[0] if isinstance(data.get(key), list) else (data.get(key) or "")
    def multi(key):
        v = data.get(key, [])
        return v if isinstance(v, list) else ([v] if v else [])

    blocks = []

    # ── Brand ──────────────────────────────────────────────────────────
    blocks += [_h2("🎨  Brand Identity"), _p("")]
    logo = g("logo_url")
    blocks.append(_p(f"Logo: {logo}" if logo else "Logo: not provided"))
    blocks.append(_p(f"Colours — Primary: {g('primary_color')}  |  Secondary: {g('secondary_color')}  |  Accent: {g('accent_color')}"))
    fonts = g("fonts")
    blocks.append(_p(f"Fonts: {fonts}" if fonts else "Fonts: not provided"))
    blocks.append(_div())

    # ── Tools ──────────────────────────────────────────────────────────
    tools = multi("tools")
    other = g("tools_other")
    if other:
        tools.append(f"Other: {other}")
    blocks += [_h2("🛠  Current Tech Stack"), _p("")]
    if tools:
        blocks.append(_p("  ·  ".join(tools)))
    else:
        blocks.append(_p("None selected / not provided"))
    blocks.append(_div())

    # ── Team ───────────────────────────────────────────────────────────
    depts = multi("depts")
    blocks += [_h2("👥  Team & Access"), _p("")]
    blocks.append(_p(f"Departments: {', '.join(depts) if depts else 'Not specified'}"))
    blocks.append(_p(f"Notion users: {g('notion_users') or 'Not specified'}"))
    blocks.append(_p(f"Notion experience: {g('notion_level') or 'Not specified'}"))
    blocks.append(_p(f"Existing workspace: {g('has_notion') or 'Not specified'}"))
    blocks.append(_div())

    # ── Package-specific ────────────────────────────────────────────────
    blocks.append(_h2(f"📋  {pkg_label} — Build Details"))
    blocks.append(_p(""))

    if pkg_slug == "sales-crm":
        blocks.append(_h3("Current CRM method"))
        blocks.append(_p(g("crm_current") or "—"))
        sources = multi("lead_sources")
        blocks.append(_h3("Lead sources"))
        blocks.append(_p(", ".join(sources) if sources else "—"))
        blocks.append(_h3("Sales pipeline stages"))
        blocks.append(_p(g("pipeline_stages") or "—"))
        metrics = multi("crm_metrics")
        blocks.append(_h3("Metrics to track"))
        blocks.append(_p(", ".join(metrics) if metrics else "—"))
        blocks.append(_h3("Active deal volume"))
        blocks.append(_p(g("deal_volume") or "—"))

    elif pkg_slug == "workflow-os":
        blocks.append(_h3("Top recurring workflows"))
        blocks.append(_p(g("top_workflows") or "—"))
        blocks.append(_h3("Workflows with most friction"))
        blocks.append(_p(g("pain_workflows") or "—"))
        blocks.append(_h3("How tasks are currently assigned"))
        blocks.append(_p(g("task_assign") or "—"))
        blocks.append(_h3("Approval processes"))
        blocks.append(_p(g("approvals") or "—"))
        blocks.append(_h3("Existing SOPs"))
        blocks.append(_p(g("has_sops") or "—"))
        sop_links = g("sop_links")
        if sop_links:
            blocks.append(_p(f"Links: {sop_links}"))

    elif pkg_slug in ("full-agency-os", "complete-os"):
        svc = multi("service_types")
        blocks.append(_h3("Services / project types"))
        blocks.append(_p(", ".join(svc) if svc else "—"))
        blocks.append(_h3("Current project delivery management"))
        blocks.append(_p(g("delivery_mgmt") or "—"))
        blocks.append(_h3("Client feedback / approval method"))
        blocks.append(_p(g("client_feedback") or "—"))
        blocks.append(_h3("Engagement model"))
        blocks.append(_p(g("engagement_model") or "—"))
        blocks.append(_h3("Capacity tracking needed?"))
        blocks.append(_p(g("capacity_tracking") or "—"))
        blocks.append(_h3("Top 3 operational pain points"))
        blocks.append(_p(g("pain_points") or "—"))

    elif pkg_slug == "revenue-os":
        blocks.append(_h3("Revenue streams"))
        blocks.append(_p(g("revenue_streams") or "—"))
        blocks.append(_h3("Current revenue tracking method"))
        blocks.append(_p(g("revenue_tracking") or "—"))
        blocks.append(_h3("Forecasting needed?"))
        blocks.append(_p(g("forecasting") or "—"))
        metrics = multi("fin_metrics")
        blocks.append(_h3("Key financial metrics"))
        blocks.append(_p(", ".join(metrics) if metrics else "—"))

    else:  # modular-os, custom-os
        modules = multi("os_modules")
        blocks.append(_h3("Requested modules"))
        blocks.append(_p(", ".join(modules) if modules else "—"))
        blocks.append(_h3("Top priority / #1 thing to fix"))
        blocks.append(_p(g("top_priority") or "—"))
        blocks.append(_h3("Specific features in mind"))
        blocks.append(_p(g("specific_requests") or "—"))

    blocks.append(_div())

    # ── Timeline ────────────────────────────────────────────────────────
    blocks += [_h2("📅  Timeline & Notes"), _p("")]
    blocks.append(_p(f"Preferred start: {g('preferred_start') or 'Not specified'}"))
    blocks.append(_p(f"Deadline: {g('deadline') or 'Not specified'}"))
    notes = g("extra_notes")
    if notes:
        blocks.append(_h3("Additional notes"))
        blocks.append(_p(notes))

    return blocks


# ─────────────────────────────────────────────
#  Form submission → Notion
# ─────────────────────────────────────────────
def submit_intake(data, company_id, pkg_slug, hdrs):
    today = date.today().isoformat()
    pkg_label = PKG_LABELS.get(pkg_slug, "Implementation")

    def g(key): return (data.get(key) or [""])[0] if isinstance(data.get(key), list) else (data.get(key) or "")

    co = get_company(company_id, hdrs)
    co_name = co["name"] if co else "Unknown Company"

    # ── Properties ──
    brand_colors = f"Primary: {g('primary_color')} | Secondary: {g('secondary_color')} | Accent: {g('accent_color')}"
    tools_list   = data.get("tools", [])
    if isinstance(tools_list, str): tools_list = [tools_list]
    other = g("tools_other")
    tools_str = ", ".join(tools_list) + (f", {other}" if other else "")

    props = {
        "Name":             {"title": [{"text": {"content": f"Implementation — {co_name}"}}]},
        "Package":          {"select": {"name": pkg_label}},
        "Status":           {"select": {"name": "Not Started"}},
        "Intake Status":    {"select": {"name": "Submitted"}},
        "Intake Submitted": {"date": {"start": today}},
        "Brand Colors":     {"rich_text": _rt(brand_colors)},
        "Current Tools":    {"rich_text": _rt(tools_str or "—")},
    }
    logo = g("logo_url")
    if logo:
        props["Logo URL"] = {"url": logo}
    fonts = g("fonts")
    if fonts:
        props["Fonts"] = {"rich_text": _rt(fonts)}
    preferred_start = g("preferred_start")
    if preferred_start:
        props["Start Date"] = {"date": {"start": preferred_start}}
    if company_id:
        props["Company"] = {"relation": [{"id": company_id}]}

    # ── Page body ──
    body_blocks = build_page_body(data, pkg_slug, pkg_label)

    page_body = {
        "parent":     {"database_id": IMPL_DB},
        "icon":       {"type": "emoji", "emoji": "📋"},
        "properties": props,
        "children":   body_blocks,
    }

    r = requests.post("https://api.notion.com/v1/pages", headers=hdrs, json=page_body, timeout=15)

    # If company relation fails, retry without it
    if not r.ok and company_id and "Company" in r.text:
        del props["Company"]
        page_body["properties"] = props
        r = requests.post("https://api.notion.com/v1/pages", headers=hdrs, json=page_body, timeout=15)

    if not r.ok:
        raise ValueError(f"Notion {r.status_code}: {r.text[:400]}")

    impl_id = r.json()["id"]
    print(f"[INFO] Implementation page created: {impl_id}", file=sys.stderr)
    return co_name


# ─────────────────────────────────────────────
#  Vercel handler
# ─────────────────────────────────────────────
def render_error_page(msg):
    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title>
<style>body{{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;background:#f7f7f5;}}
.c{{background:#fff;padding:40px;border-radius:12px;max-width:440px;text-align:center;}}
h2{{color:#cc0000;margin-bottom:10px;}}p{{color:#666;font-size:14px;}}</style></head>
<body><div class="c"><h2>Something went wrong</h2><p>{msg}</p></div></body></html>"""


class handler(BaseHTTPRequestHandler):

    def _html(self, code, html):
        body = html.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        qs         = parse_qs(urlparse(self.path).query)
        company_id = (qs.get("c") or qs.get("company_id") or [""])[0].strip()
        pkg_slug   = (qs.get("pkg") or ["workflow-os"])[0].strip().lower()

        if not company_id:
            self._html(400, render_error_page(
                "Missing company ID. Link should be:<br>"
                "<code>/api/implementation_form?c=NOTION_PAGE_ID&pkg=workflow-os</code>"))
            return

        hdrs = notion_headers()
        co   = get_company(company_id, hdrs)
        if not co:
            self._html(404, render_error_page(f"Company not found: {company_id}"))
            return

        self._html(200, render_form(co["name"], company_id, pkg_slug))

    def do_POST(self):
        try:
            qs        = parse_qs(urlparse(self.path).query)
            length    = int(self.headers.get("Content-Length", 0))
            raw       = self.rfile.read(length) if length else b""
            data      = parse_qs(raw.decode("utf-8", errors="replace"))

            company_id = ((data.get("company_id") or [""])[0] or (qs.get("c") or [""])[0]).strip()
            pkg_slug   = ((data.get("pkg_slug") or [""])[0] or (qs.get("pkg") or ["workflow-os"])[0]).strip().lower()

            if not company_id:
                self._html(400, render_error_page("Missing company ID."))
                return

            hdrs    = notion_headers()
            co_name = submit_intake(data, company_id, pkg_slug, hdrs)
            self._html(200, render_success(co_name))

        except Exception as e:
            import traceback
            traceback.print_exc(file=sys.stderr)
            self._html(500, render_error_page(str(e)))
