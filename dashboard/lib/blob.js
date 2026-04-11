// ─── Vercel Blob helpers ───────────────────────────────────────────────────

import { put, del, list } from "@vercel/blob"

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN

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
  return { url: blob.url, pathname: blob.pathname }
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
