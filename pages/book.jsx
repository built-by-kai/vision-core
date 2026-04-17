import Head from "next/head";
import { useState, useEffect, useRef } from "react";

const STEPS = ["contact", "business", "needs", "result"];

const INDUSTRIES = [
  "Marketing & Creative Agency",
  "Consulting & Advisory",
  "Media & Content Production",
  "Events & Experiential",
  "PR & Communications",
  "Technology & SaaS",
  "E-Commerce & Retail",
  "Real Estate",
  "Education & Training",
  "Health & Wellness",
  "Legal & Professional Services",
  "Finance & Accounting",
  "Manufacturing",
  "Printing & Packaging",
  "Service Business",
  "Other",
];

const OS_OPTIONS = [
  "Revenue OS",
  "Operations OS",
  "Business OS",
  "Marketing OS",
  "Agency OS",
  "Not Sure Yet",
];

const SOURCES = [
  "Threads",
  "Instagram",
  "LinkedIn",
  "TikTok",
  "WhatsApp",
  "Referral",
  "Ads",
  "Other",
];

export default function Book() {
  const [step, setStep] = useState(0); // 0=contact, 1=business, 2=needs, 3=result
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { qualified, reason }
  const calEmbedRef = useRef(null);

  const [form, setForm] = useState({
    // Step 1
    name: "",
    company: "",
    email: "",
    phone: "",
    // Step 2
    role: "",
    teamSize: "",
    industry: "",
    monthlyRevenue: "",
    // Step 3
    budget: "",
    osInterest: [],
    situation: "",
    source: "",
    // UTM (captured from URL)
    utmSource: "",
    utmMedium: "",
    utmCampaign: "",
  });

  // Capture UTM params on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setForm((f) => ({
      ...f,
      utmSource: params.get("utm_source") || "",
      utmMedium: params.get("utm_medium") || "",
      utmCampaign: params.get("utm_campaign") || "",
    }));
  }, []);

  // Inject Cal.com embed after qualified
  useEffect(() => {
    if (result?.qualified && calEmbedRef.current) {
      const script = document.createElement("script");
      script.src = "https://cal.com/embed.js";
      script.async = true;
      script.onload = () => {
        if (window.Cal) {
          window.Cal("init", { origin: "https://cal.com" });
          window.Cal("inline", {
            elementOrSelector: "#cal-embed",
            calLink: "kai-opxio/discovery-call",
            config: {
              name: form.name,
              email: form.email,
              notes: form.situation,
              guests: [],
            },
          });
          window.Cal("ui", {
            styles: { branding: { brandColor: "#AAFF00" } },
            hideEventTypeDetails: false,
          });
        }
      };
      document.body.appendChild(script);
    }
  }, [result]);

  const set = (field, value) => setForm((f) => ({ ...f, [field]: value }));
  const toggleOS = (val) =>
    setForm((f) => ({
      ...f,
      osInterest: f.osInterest.includes(val)
        ? f.osInterest.filter((x) => x !== val)
        : [...f.osInterest, val],
    }));

  const nextStep = () => setStep((s) => s + 1);
  const prevStep = () => setStep((s) => s - 1);

  const step1Valid =
    form.name && form.company && form.email && form.phone;
  const step2Valid =
    form.role && form.teamSize && form.industry && form.monthlyRevenue;
  const step3Valid = form.budget;

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/qualify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      setResult(data);
      setStep(3);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Book a Discovery Call — Opxio</title>
        <meta
          name="description"
          content="See if Opxio is the right fit for your business. Answer a few quick questions to book your free discovery call."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&display=swap"
          rel="stylesheet"
        />
      </Head>

      <style jsx global>{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          background: #0a0a0a;
          color: #fff;
          font-family: "Satoshi", sans-serif;
          min-height: 100vh;
        }
        ::selection {
          background: #aaff00;
          color: #000;
        }
        ::-webkit-scrollbar {
          width: 6px;
        }
        ::-webkit-scrollbar-track {
          background: #111;
        }
        ::-webkit-scrollbar-thumb {
          background: #333;
          border-radius: 3px;
        }
        .btn-back:hover {
          border-color: #AAFF00 !important;
          color: #AAFF00 !important;
        }
      `}</style>

      <div style={styles.page}>
        {/* Header */}
        <header style={styles.header}>
          <div style={styles.logo}>
            <span style={styles.logoText}>Opxio</span>
          </div>
        </header>

        {/* Hero */}
        {step < 3 && (
          <div style={styles.hero}>
            <div style={styles.badge}>Free Discovery Call</div>
            <h1 style={styles.heroTitle}>
              Let&apos;s see if we&apos;re<br />
              <span style={styles.accent}>a good fit.</span>
            </h1>
            <p style={styles.heroSub}>
              Answer a few questions — takes 2 minutes. If we&apos;re aligned,
              you&apos;ll book directly on this page.
            </p>

            {/* Progress */}
            <div style={styles.progress}>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    ...styles.progressDot,
                    ...(i === step ? styles.progressDotActive : {}),
                    ...(i < step ? styles.progressDotDone : {}),
                  }}
                />
              ))}
            </div>
            <p style={styles.stepLabel}>
              Step {step + 1} of 3 —{" "}
              {step === 0
                ? "Contact Info"
                : step === 1
                ? "Your Business"
                : "What You Need"}
            </p>
          </div>
        )}

        {/* Form Card */}
        <div style={styles.cardWrap}>
          <div style={styles.card}>
            {/* STEP 1: Contact */}
            {step === 0 && (
              <div style={styles.formSection}>
                <h2 style={styles.sectionTitle}>Who are we talking to?</h2>

                <div style={styles.row}>
                  <Field
                    label="Full Name"
                    required
                    value={form.name}
                    onChange={(v) => set("name", v)}
                    placeholder="Ahmad Zulkifli"
                  />
                  <Field
                    label="Company"
                    required
                    value={form.company}
                    onChange={(v) => set("company", v)}
                    placeholder="Your company name"
                  />
                </div>
                <div style={styles.row}>
                  <Field
                    label="Email"
                    required
                    type="email"
                    value={form.email}
                    onChange={(v) => set("email", v)}
                    placeholder="you@company.com"
                  />
                  <Field
                    label="Phone / WhatsApp"
                    required
                    type="tel"
                    value={form.phone}
                    onChange={(v) => set("phone", v)}
                    placeholder="+60 12-345 6789"
                  />
                </div>

                <button
                  style={{
                    ...styles.btn,
                    opacity: step1Valid ? 1 : 0.4,
                    cursor: step1Valid ? "pointer" : "not-allowed",
                  }}
                  onClick={step1Valid ? nextStep : undefined}
                >
                  Continue →
                </button>
              </div>
            )}

            {/* STEP 2: Business */}
            {step === 1 && (
              <div style={styles.formSection}>
                <h2 style={styles.sectionTitle}>Tell us about your business.</h2>

                <div style={styles.row}>
                  <SelectField
                    label="Your Role"
                    required
                    value={form.role}
                    onChange={(v) => set("role", v)}
                    options={[
                      "Founder / CEO",
                      "COO / Operations",
                      "CMO / Marketing",
                      "CFO / Finance",
                      "General Manager",
                      "Operations Manager",
                      "Marketing Manager",
                      "Project Manager",
                      "Employee / Staff",
                      "Other",
                    ]}
                  />
                  <SelectField
                    label="Team Size"
                    required
                    value={form.teamSize}
                    onChange={(v) => set("teamSize", v)}
                    options={["1–4", "5–10", "11–20", "21–50", "50+"]}
                  />
                </div>
                <SelectField
                  label="Industry"
                  required
                  value={form.industry}
                  onChange={(v) => set("industry", v)}
                  options={INDUSTRIES}
                  wide
                />
                <SelectField
                  label="Monthly Revenue"
                  required
                  value={form.monthlyRevenue}
                  onChange={(v) => set("monthlyRevenue", v)}
                  options={[
                    "Under RM 15K",
                    "RM 15K–30K",
                    "RM 30K–100K",
                    "RM 100K–200K",
                    "RM 200K+",
                  ]}
                  wide
                />

                <div style={styles.btnRow}>
                  <button className="btn-back" style={styles.btnBack} onClick={prevStep}>
                    ←
                  </button>
                  <button
                    style={{
                      ...styles.btn,
                      opacity: step2Valid ? 1 : 0.4,
                      cursor: step2Valid ? "pointer" : "not-allowed",
                    }}
                    onClick={step2Valid ? nextStep : undefined}
                  >
                    Continue →
                  </button>
                </div>
              </div>
            )}

            {/* STEP 3: Needs */}
            {step === 2 && (
              <div style={styles.formSection}>
                <h2 style={styles.sectionTitle}>What are you looking to build?</h2>

                <SelectField
                  label="Investment Budget"
                  required
                  value={form.budget}
                  onChange={(v) => set("budget", v)}
                  options={[
                    "Under RM 1500",
                    "RM 1500 - RM 3500",
                    "RM 3500 - RM 6500",
                    "RM 6500+",
                    "Not sure yet",
                  ]}
                  wide
                />

                <div style={styles.fieldWrap}>
                  <label style={styles.label}>
                    What are you looking to build?{" "}
                    <span style={styles.optional}>(optional)</span>
                  </label>
                  <div style={styles.chipGroup}>
                    {OS_OPTIONS.map((o) => (
                      <button
                        key={o}
                        style={{
                          ...styles.chip,
                          ...(form.osInterest.includes(o)
                            ? styles.chipActive
                            : {}),
                        }}
                        onClick={() => toggleOS(o)}
                        type="button"
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={styles.fieldWrap}>
                  <label style={styles.label}>
                    Biggest operational challenge right now{" "}
                    <span style={styles.optional}>(optional)</span>
                  </label>
                  <textarea
                    style={styles.textarea}
                    rows={3}
                    value={form.situation}
                    onChange={(e) => set("situation", e.target.value)}
                    placeholder="e.g. We track everything in spreadsheets and nothing is connected..."
                  />
                </div>

                <SelectField
                  label="How did you find us?"
                  value={form.source}
                  onChange={(v) => set("source", v)}
                  options={SOURCES}
                  wide
                />

                <div style={styles.btnRow}>
                  <button className="btn-back" style={styles.btnBack} onClick={prevStep}>
                    ←
                  </button>
                  <button
                    style={{
                      ...styles.btn,
                      opacity: step3Valid && !loading ? 1 : 0.4,
                      cursor:
                        step3Valid && !loading ? "pointer" : "not-allowed",
                    }}
                    onClick={step3Valid && !loading ? handleSubmit : undefined}
                  >
                    {loading ? "Checking…" : "Submit →"}
                  </button>
                </div>
              </div>
            )}

            {/* STEP 4: Result */}
            {step === 3 && result?.qualified && (
              <div style={styles.formSection}>
                <div style={styles.qualifiedBadge}>✓ You&apos;re a great fit</div>
                <h2 style={styles.sectionTitle}>
                  Pick a time that works for you.
                </h2>
                <p style={styles.calSub}>
                  This is a free 30-minute discovery call with Kai.
                </p>
                <div
                  id="cal-embed"
                  ref={calEmbedRef}
                  style={styles.calEmbed}
                />
              </div>
            )}

            {step === 3 && result && !result.qualified && (
              <div style={styles.formSection}>
                <div style={styles.disqualBadge}>Not quite a fit — yet.</div>
                <h2 style={styles.sectionTitle}>
                  We&apos;re not the right match right now.
                </h2>
                <p style={styles.disqualText}>
                  {result.reason === "budget_too_low"
                    ? "Opxio's systems start from RM 1,500. When you're ready to invest in your operations infrastructure, we'd love to connect."
                    : result.reason === "revenue_too_low"
                    ? "We work best with businesses generating at least RM 15K/month. Once your revenue grows, Opxio will be here."
                    : "Based on your answers, we're not the right fit at this stage. This doesn't mean never — just not right now."}
                </p>
                <p style={styles.disqualTextSmall}>
                  We&apos;ll keep your details on file. If things change,{" "}
                  <a href="mailto:kai@opxio.io" style={styles.link}>
                    reach out to Kai directly.
                  </a>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer style={styles.footer}>
          <p style={styles.footerText}>
            © {new Date().getFullYear()} Opxio. All rights reserved.
          </p>
        </footer>
      </div>
    </>
  );
}

// ─── Reusable Field Components ──────────────────────────────────────────────

function Field({ label, required, type = "text", value, onChange, placeholder }) {
  return (
    <div style={styles.fieldWrap}>
      <label style={styles.label}>
        {label} {required && <span style={styles.required}>*</span>}
      </label>
      <input
        type={type}
        style={styles.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
    </div>
  );
}

function SelectField({ label, required, value, onChange, options, wide }) {
  return (
    <div style={{ ...styles.fieldWrap, ...(wide ? styles.fullWidth : {}) }}>
      <label style={styles.label}>
        {label} {required && <span style={styles.required}>*</span>}
      </label>
      <select
        style={styles.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    background: "#0a0a0a",
  },
  header: {
    width: "100%",
    padding: "24px 32px",
    display: "flex",
    alignItems: "center",
    borderBottom: "1px solid #1a1a1a",
  },
  logo: { display: "flex", alignItems: "center", gap: 8 },
  logoText: {
    fontSize: 20,
    fontWeight: 700,
    color: "#AAFF00",
    letterSpacing: "-0.5px",
  },
  hero: {
    textAlign: "center",
    padding: "64px 24px 40px",
    maxWidth: 600,
    width: "100%",
  },
  badge: {
    display: "inline-block",
    background: "#AAFF0018",
    color: "#AAFF00",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "6px 14px",
    borderRadius: 100,
    marginBottom: 24,
    border: "1px solid #AAFF0033",
  },
  heroTitle: {
    fontSize: "clamp(32px, 5vw, 52px)",
    fontWeight: 700,
    lineHeight: 1.1,
    letterSpacing: "-1.5px",
    marginBottom: 16,
  },
  accent: { color: "#AAFF00" },
  heroSub: {
    fontSize: 16,
    color: "#888",
    lineHeight: 1.6,
    marginBottom: 32,
  },
  progress: {
    display: "flex",
    gap: 8,
    justifyContent: "center",
    marginBottom: 8,
  },
  progressDot: {
    width: 32,
    height: 4,
    borderRadius: 2,
    background: "#222",
    transition: "all 0.2s",
  },
  progressDotActive: { background: "#AAFF00" },
  progressDotDone: { background: "#AAFF0066" },
  stepLabel: { fontSize: 13, color: "#555", marginBottom: 0 },
  cardWrap: {
    width: "100%",
    maxWidth: 680,
    padding: "0 24px 80px",
  },
  card: {
    background: "#111",
    border: "1px solid #1e1e1e",
    borderRadius: 16,
    overflow: "hidden",
  },
  formSection: { padding: "40px" },
  sectionTitle: {
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: "-0.5px",
    marginBottom: 28,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
    marginBottom: 0,
  },
  fieldWrap: { marginBottom: 20 },
  fullWidth: { gridColumn: "1 / -1" },
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 500,
    color: "#aaa",
    marginBottom: 8,
    letterSpacing: "0.01em",
  },
  required: { color: "#AAFF00" },
  optional: { color: "#444", fontWeight: 400 },
  input: {
    width: "100%",
    background: "#0a0a0a",
    border: "1px solid #2a2a2a",
    borderRadius: 8,
    padding: "12px 14px",
    color: "#fff",
    fontSize: 15,
    fontFamily: "Satoshi, sans-serif",
    outline: "none",
    transition: "border-color 0.15s",
  },
  select: {
    width: "100%",
    background: "#0a0a0a",
    border: "1px solid #2a2a2a",
    borderRadius: 8,
    padding: "12px 14px",
    color: "#fff",
    fontSize: 15,
    fontFamily: "Satoshi, sans-serif",
    outline: "none",
    cursor: "pointer",
    appearance: "none",
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23555' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 14px center",
  },
  textarea: {
    width: "100%",
    background: "#0a0a0a",
    border: "1px solid #2a2a2a",
    borderRadius: 8,
    padding: "12px 14px",
    color: "#fff",
    fontSize: 15,
    fontFamily: "Satoshi, sans-serif",
    outline: "none",
    resize: "vertical",
    lineHeight: 1.6,
  },
  chipGroup: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    background: "#0a0a0a",
    border: "1px solid #2a2a2a",
    borderRadius: 100,
    padding: "8px 16px",
    color: "#aaa",
    fontSize: 13,
    fontFamily: "Satoshi, sans-serif",
    cursor: "pointer",
    transition: "all 0.15s",
  },
  chipActive: {
    background: "#AAFF0018",
    border: "1px solid #AAFF00",
    color: "#AAFF00",
  },
  btn: {
    width: "100%",
    background: "#AAFF00",
    color: "#000",
    border: "none",
    borderRadius: 14,
    padding: "14px 24px",
    fontSize: 15,
    fontWeight: 700,
    fontFamily: "Satoshi, sans-serif",
    cursor: "pointer",
    marginTop: 8,
    transition: "opacity 0.15s",
    letterSpacing: "-0.2px",
  },
  btnRow: {
    display: "flex",
    gap: 12,
    marginTop: 8,
  },
  btnBack: {
    flex: "0 0 auto",
    width: 48,
    height: 48,
    marginTop: 8,
    background: "transparent",
    color: "#555",
    border: "1px solid #2a2a2a",
    borderRadius: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
    cursor: "pointer",
    transition: "border-color 0.15s, color 0.15s",
    flexShrink: 0,
  },
  qualifiedBadge: {
    display: "inline-block",
    background: "#AAFF0018",
    color: "#AAFF00",
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 14px",
    borderRadius: 100,
    marginBottom: 16,
    border: "1px solid #AAFF0033",
  },
  calSub: {
    color: "#666",
    fontSize: 14,
    marginBottom: 28,
    marginTop: -8,
  },
  calEmbed: {
    minHeight: 500,
    borderRadius: 8,
    overflow: "hidden",
  },
  disqualBadge: {
    display: "inline-block",
    background: "#ff444418",
    color: "#ff6666",
    fontSize: 13,
    fontWeight: 600,
    padding: "6px 14px",
    borderRadius: 100,
    marginBottom: 16,
    border: "1px solid #ff444433",
  },
  disqualText: {
    color: "#aaa",
    fontSize: 15,
    lineHeight: 1.7,
    marginBottom: 16,
  },
  disqualTextSmall: {
    color: "#555",
    fontSize: 14,
    lineHeight: 1.6,
  },
  link: { color: "#AAFF00", textDecoration: "none" },
  footer: {
    padding: "24px",
    borderTop: "1px solid #1a1a1a",
    width: "100%",
    textAlign: "center",
    marginTop: "auto",
  },
  footerText: { color: "#333", fontSize: 13 },
};
