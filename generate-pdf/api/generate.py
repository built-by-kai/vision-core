# /api/generate.py

import json
import os
import sys
from datetime import datetime
from urllib.parse import parse_qs

# import EVERYTHING from your existing file
# (keep all your helper functions exactly the same)
# fetch_quotation_data, generate_pdf, upload_to_blob, update_notion_page, etc.

def handler(request):
    try:
        if request.method == "GET":
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "service": "Vision Core Quotation PDF Generator",
                    "status": "ready"
                })
            }

        if request.method != "POST":
            return {
                "statusCode": 405,
                "body": json.dumps({"error": "Method not allowed"})
            }

        # Optional auth
        WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
        if WEBHOOK_SECRET:
            auth = request.headers.get("authorization", "")
            if auth != f"Bearer {WEBHOOK_SECRET}":
                return {
                    "statusCode": 401,
                    "body": json.dumps({"error": "Unauthorized"})
                }

        # Parse JSON body
        try:
            body = request.json()
        except:
            body = {}

        print(f"[DEBUG] Payload keys: {list(body.keys())}", file=sys.stderr)

        # Extract page_id
        page_id = None

        if "source" in body and "page_id" in body.get("source", {}):
            page_id = body["source"]["page_id"]

        elif "data" in body and "page_id" in body["data"]:
            page_id = body["data"]["page_id"]

        elif "page_id" in body:
            page_id = body["page_id"]

        # Fallback: query param
        if not page_id:
            query = request.query
            page_id = query.get("pageId")

        if not page_id:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "No page_id found"})
            }

        print(f"Generating PDF for page: {page_id}", file=sys.stderr)

        # Fetch data
        data = fetch_quotation_data(page_id)

        # Generate PDF
        pdf_buffer = generate_pdf(data)

        # Upload
        safe_name = data["quotation_no"].replace(" ", "-").replace("/", "-")
        filename = f"quotations/{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"

        pdf_url = upload_to_blob(pdf_buffer, filename)

        # Compute total
        total_amount = sum(
            item.get("qty", 1) * item.get("unit_price", 0)
            for item in data.get("line_items", [])
        )

        # Update Notion
        update_notion_page(page_id, pdf_url, total_amount)

        return {
            "statusCode": 200,
            "body": json.dumps({
                "status": "success",
                "quotation_no": data["quotation_no"],
                "pdf_url": pdf_url,
            })
        }

    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
