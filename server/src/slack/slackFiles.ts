/**
 * Download a file a user shared in Slack. Slack file URLs are private and
 * require the bot token as a Bearer credential. Returns the raw bytes plus the
 * mimetype, ready to hand to Gemini for OCR and/or re-upload to the ERP API.
 */
export interface DownloadedFile {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}

export async function downloadSlackFile(file: {
  url_private_download?: string;
  url_private?: string;
  mimetype?: string;
  name?: string;
}): Promise<DownloadedFile> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) throw new Error('Slack file has no download URL');

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Failed to download Slack file (${res.status})`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimetype: file.mimetype ?? res.headers.get('content-type') ?? 'application/octet-stream',
    filename: file.name ?? 'upload',
  };
}
