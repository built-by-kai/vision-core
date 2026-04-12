// ─── Vercel Blob helpers ───────────────────────────────────────────────────

import { put, del, list } from "@vercel/blob"

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN

// Custom domain for Blob — set once your DNS CNAME is live.
// Leave null to use the default Vercel Blob URL until the domain is configured.
// e.g. "https://files.opxio.io"
const BLOB_CUSTOM_DOMAIN = process.env.BLOB_CUSTOM_DOMAIN || null

/**
 * Rewrites a Vercel Blob URL to use the custom domain if configured.
 * e.g. https://j1essleg2ckfwrbt.public.blob.vercel-storage.com/proposals/x.pdf
 *   → https://files.opxio.io/proposals/x.pdf
 */
function toCustomUrl(blobUrl) {
  if (!BLOB_CUSTOM_DOMAIN || !blobUrl) return blobUrl
  try {
    const u = new URL(blobUrl)
    return `${BLOB_CUSTOM_DOMAIN}${u.pathname}${u.search}`
  } catch {
    return blobUrl
  }
}

/**
 * Upload a buffer to Vercel Blob
 * @param {string} filename  - e.g. "quotation-QT-001.pdf"
 * @param {Buffer|Uint8Array} buffer
 * @param {string} contentType - default "application/pdf"
 * @returns {Promise<{url: string, pathname: string}>}
 */
export async function uploadBlob(filename, buffer, contentType = "application/pdf") {
  const blob = await put(filename, buffer, {
    access: "public",
    token: BLOB_TOKEN,
    contentType,
    addRandomSuffix: false,
  })
  return { url: toCustomUrl(blob.url), pathname: blob.pathname }
}

/**
 * Delete a blob by URL
 */
export async function deleteBlob(url) {
  if (!url) return
  try {
    await del(url, { token: BLOB_TOKEN })
  } catch (e) {
    console.warn("[blob] delete failed:", e.message)
  }
}

/**
 * List blobs with optional prefix
 */
export async function listBlobs(prefix = "") {
  return list({ prefix, token: BLOB_TOKEN })
}

