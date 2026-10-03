export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

// Locked catalog-studio prompt. Bump PROMPT_VERSION when STYLE_BIBLE changes.
export const PROMPT_VERSION = 'archive-look.v1';
export const IMAGINE_MODEL = 'grok-imagine-image-2.0';

export const STYLE_BIBLE = [
  'Archive catalog studio hero.',
  'Material-true: preserve the exact silhouette, proportions, colors, materials, textures, stitching, hardware, and visible wear from the reference image.',
  'Do not invent, restyle, or improve the object.',
  'Place the same object on a soft, neutral Archive catalog backdrop with even studio light and shallow depth of field.',
  'No props, mannequins, hands, hangers, logos, captions, watermarks, or text overlays.',
  'Photoreal catalog photography, not illustration.',
].join(' ');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function buildPrompt(name, category) {
  const subject = [name, category].filter(Boolean).join(' · ');
  return subject
    ? `${STYLE_BIBLE} Subject: ${subject}.`
    : STYLE_BIBLE;
}

// Accept a public URL, a data URI, or raw base64. xAI images/edits is JSON,
// not OpenAI SDK multipart: image.url may be a URL or data: URI.
function normalizeImageRef(image) {
  if (!image || typeof image !== 'string') return null;
  const trimmed = image.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:image/')) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

function payload(fields) {
  return {
    displayImage: fields.displayImage ?? null,
    originalImage: fields.originalImage ?? null,
    model: IMAGINE_MODEL,
    promptVersion: PROMPT_VERSION,
    ...fields.extra,
  };
}

async function urlToDataUri(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Could not download result image (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function asDataUri(b64, mime = 'image/jpeg') {
  if (!b64) return null;
  if (b64.startsWith('data:image/')) return b64;
  return `data:${mime};base64,${b64}`;
}

async function persistItemImages(itemId, { displayImage, originalImage, status }) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!itemId || !url || !key) return;

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  let existing = null;
  try {
    const get = await fetch(
      `${url}/rest/v1/items?id=eq.${encodeURIComponent(itemId)}&select=id,image_original,image_display,image_status&limit=1`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (get.ok) {
      const rows = await get.json();
      existing = Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
  } catch (e) {
    console.warn('[archive-look] supabase read skipped:', e.message);
    return;
  }

  const patch = {
    image_display: displayImage,
    image_status: status,
  };
  if (!existing?.image_original && originalImage) {
    patch.image_original = originalImage;
  }

  try {
    await fetch(
      `${url}/rest/v1/items?id=eq.${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(8000),
      }
    );
  } catch (e) {
    console.warn('[archive-look] supabase write skipped:', e.message);
  }
}

async function imagineEdit(imageRef, prompt) {
  const r = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGINE_MODEL,
      prompt,
      image: { url: imageRef, type: 'image_url' },
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(50000),
  });

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!r.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 240);
    throw new Error(`xAI images/edits ${r.status}: ${msg}`);
  }
  if (data?.error) {
    throw new Error(data.error.message || 'xAI images/edits error');
  }

  const first = data?.data?.[0] || data;
  if (first?.b64_json) return asDataUri(first.b64_json);
  if (first?.url) return urlToDataUri(first.url);
  if (typeof first?.image === 'string') {
    return first.image.startsWith('http') ? urlToDataUri(first.image) : asDataUri(first.image);
  }
  throw new Error('xAI images/edits returned no image');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { itemId, image, name, category } = req.body ?? {};
  const originalImage = normalizeImageRef(image);

  // Plaid-only items without photos should no-op/skip (callers skip when no image).
  if (!originalImage) {
    return res.status(200).json(payload({
      displayImage: null,
      originalImage: null,
      extra: {
        skipped: true,
        warning: 'No reference image — Archive Look skipped. Plaid items without originals no-op until a photo or visual-ref is available.',
      },
    }));
  }

  const XAI_API_KEY = process.env.XAI_API_KEY;
  if (!XAI_API_KEY) {
    console.error('[archive-look] Missing XAI_API_KEY');
    await persistItemImages(itemId, { displayImage: null, originalImage, status: 'error' });
    return res.status(200).json(payload({
      displayImage: originalImage,
      originalImage,
      extra: { error: 'Missing XAI_API_KEY', warning: 'Archive Look soft-failed; returning original as displayImage.' },
    }));
  }

  const prompt = buildPrompt(name, category);
  console.log(`[archive-look] itemId=${itemId || '(none)'} name="${name || ''}" cat="${category || ''}"`);

  try {
    const displayImage = await imagineEdit(originalImage, prompt);
    await persistItemImages(itemId, { displayImage, originalImage, status: 'ready' });
    return res.status(200).json(payload({ displayImage, originalImage }));
  } catch (error) {
    console.error('[archive-look] Imagine failed:', error.message);
    await persistItemImages(itemId, { displayImage: null, originalImage, status: 'error' });
    return res.status(200).json(payload({
      displayImage: originalImage,
      originalImage,
      extra: { error: error.message, warning: 'Archive Look soft-failed; returning original as displayImage.' },
    }));
  }
}
