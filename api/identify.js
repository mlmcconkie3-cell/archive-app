export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

// Extract a JSON object from a string that may contain surrounding prose.
// GPT sometimes wraps the JSON in text like "Here you go:\n{...}" even when
// told not to — this handles that gracefully instead of throwing on JSON.parse.
function extractJSON(raw) {
  // 1. Strip markdown code fences
  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  // 2. Try a direct parse first (fastest path — works when GPT behaves)
  try { return JSON.parse(stripped); } catch {}
  // 3. Find the first {...} block in case there's leading/trailing prose
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) {
      console.error('[extractJSON] matched block failed to parse:', e.message, '\nBlock:', match[0]);
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Log key presence immediately so Vercel logs show the failure point
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  console.log('[identify] OPENAI_API_KEY present:', !!OPENAI_API_KEY);

  if (!OPENAI_API_KEY) {
    console.error('[identify] Missing OPENAI_API_KEY environment variable');
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
  }

  try {
    const { image, description, context } = req.body;
    const systemPrompt = context || 'You are an expert collectibles appraiser with deep knowledge of sneakers, trading cards, watches, luxury goods, tech, and collectibles resale markets.';

    if (!image && !description) {
      return res.status(400).json({ error: 'No image or description provided' });
    }

    const JSON_PROMPT = `Return ONLY a valid JSON object — no markdown, no prose, nothing else:
{"name":"full specific item name","sub":"year, edition, colorway, key details","cat":"Trading Card or Sneaker or Watch or Sports Card or Coin or Tech or Clothing or Luxury or Home or Entertainment or Other","cond":"Mint or Near Mint or Very Good or Good or Fair or Poor","val":1234,"conf":"94%"}
The val field must be an integer (USD). If unsure of any field, return your best estimate with a lower conf value.`;

    let messages;
    let mode;

    if (image && description) {
      mode = 'photo+description';
      // Vision model with both image and text context
      messages = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
            { type: 'text', text: `The user describes this item as: "${description}". Use both the image and the description to identify it as precisely as possible.\n\n${JSON_PROMPT}` }
          ]
        }
      ];
    } else if (image) {
      mode = 'photo-only';
      // Vision model, image only
      messages = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
            { type: 'text', text: `Identify this item and estimate its current US resale market value.\n\n${JSON_PROMPT}` }
          ]
        }
      ];
    } else {
      mode = 'text-only';
      // Text-only — use system+user roles so GPT stays in JSON mode
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Identify this item and estimate its current US resale market value: "${description}"\n\n${JSON_PROMPT}` }
      ];
    }

    console.log(`[identify] mode=${mode} description="${description || '(none)'}"`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 400,
        temperature: 0,        // deterministic JSON output
        messages,
      })
    });

    // Log and surface HTTP-level errors from OpenAI
    if (!response.ok) {
      const errText = await response.text();
      console.error(`[identify] OpenAI HTTP ${response.status}:`, errText);
      return res.status(502).json({ error: `OpenAI returned ${response.status}: ${errText.slice(0, 200)}` });
    }

    const data = await response.json();

    // API-level error object (e.g. invalid_api_key, rate_limit)
    if (data.error) {
      console.error('[identify] OpenAI API error:', JSON.stringify(data.error));
      return res.status(500).json({ error: data.error.message });
    }

    if (!data.choices?.[0]?.message?.content) {
      console.error('[identify] Unexpected OpenAI response shape:', JSON.stringify(data));
      return res.status(500).json({ error: 'No content in OpenAI response' });
    }

    const rawText = data.choices[0].message.content;
    console.log('[identify] raw GPT output:', rawText);

    const item = extractJSON(rawText);
    if (!item) {
      console.error('[identify] JSON extraction failed. Raw text was:', rawText);
      return res.status(500).json({ error: 'Could not parse JSON from GPT response', raw: rawText });
    }

    // Normalise val to a number in case GPT returns it as a string
    if (typeof item.val === 'string') {
      item.val = parseInt(item.val.replace(/[^0-9]/g, ''), 10) || 0;
    }

    console.log('[identify] parsed item:', JSON.stringify(item));
    return res.status(200).json(item);

  } catch (error) {
    // Log the full stack so Vercel function logs show exactly where it blew up
    console.error('[identify] unhandled error:', error.message, '\n', error.stack);
    return res.status(500).json({ error: error.message });
  }
}
