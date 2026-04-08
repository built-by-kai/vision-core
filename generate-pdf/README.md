# builtbykai — Quotation PDF Generator

Vercel serverless function that generates branded PDF quotations from Notion data.

## How it works

1. Click "Generate PDF" button on a Notion Quotation page
2. Notion sends webhook POST to this Vercel function
3. Function pulls quotation data via Notion API (page props, company, PIC, line items)
4. Generates a dark navy + gold branded PDF using ReportLab
5. Uploads PDF to Vercel Blob Storage
6. Writes the PDF URL back to the Notion page's "PDF" property

## Setup

### 1. Create a Notion Internal Integration
- Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
- Create a new integration, copy the token

### 2. Share your databases with the integration
- Open each database (Companies, Contacts, Quotations) in Notion
- Click "..." → "Connections" → Add your integration

### 3. Deploy to Vercel
```bash
cd generate-pdf
vercel deploy --prod
```

### 4. Add Vercel Blob Storage
- In your Vercel project dashboard → Storage → Create Blob Store
- Copy the `BLOB_READ_WRITE_TOKEN`

### 5. Set environment variables
In Vercel project settings → Environment Variables:
- `NOTION_API_KEY` — your Notion integration token
- `BLOB_READ_WRITE_TOKEN` — from Vercel Blob
- `WEBHOOK_SECRET` (optional) — shared secret for auth

### 6. Configure Notion button
- On your Quotation database, add a Button property called "Generate PDF"
- Edit the button → Add action → "Send webhook request"
- URL: `https://your-project.vercel.app/api/generate`
- (Optional) Add header `Authorization: Bearer your-webhook-secret`

## Template

The PDF uses a dark navy + gold color scheme with:
- Gold accent strip and corner fold decoration
- Dark navy table headers
- Gold-highlighted TOTAL row
- Payment method and T&C side by side
- Signature block at the bottom
- Dark footer band

## Customization

Edit the `COMPANY_INFO` and `TERMS` dicts at the top of `api/generate.py` to match your business details.
