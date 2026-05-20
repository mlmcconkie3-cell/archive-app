export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image, description, context } = req.body;
    const contextStr = context || 'You are an expert collectibles appraiser.';

    if (!image && !description) {
      return res.status(400).json({ error: 'No image or description provided' });
    }

    if (!process.env.OPENAI_KEY) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const JSON_PROMPT = `Return ONLY valid JSON with no markdown backticks:
{"name":"full item name","sub":"year, edition, key details","cat":"Trading Card or Sneaker or Watch or Sports Card or Coin or Tech or Clothing or Luxury or Home or Entertainment or Other","cond":"Mint or Near Mint or Very Good or Good or Fair or Poor","val":estimated_usd_number,"conf":"confidence like 94%"}
If unsure, return best guess with lower confidence.`;

    let messages;

    if (image && description) {
      // Both photo AND description — use vision with text context
      console.log('Mode: photo + description');
      messages = [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${image}` }
          },
          {
            type: 'text',
            text: `${contextStr} The user describes this item as: "${description}". Use both the image and the description to identify it as accurately as possible. ${JSON_PROMPT}`
          }
        ]
      }];
    } else if (image) {
      // Photo only — vision identification
      console.log('Mode: photo only');
      messages = [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${image}` }
          },
          {
            type: 'text',
            text: `${contextStr} Identify this item. ${JSON_PROMPT}`
          }
        ]
      }];
    } else {
      // Text only — identify from description alone
      console.log('Mode: text only, description:', description);
      messages = [{
        role: 'user',
        content: `${contextStr} The user just acquired this item and describes it as: "${description}". Identify it and estimate its current market value. ${JSON_PROMPT}`
      }];
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 400,
        messages
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('OpenAI error:', JSON.stringify(data.error));
      return res.status(500).json({ error: data.error.message });
    }

    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: 'No response from AI' });
    }

    const text = data.choices[0].message.content.replace(/```json|```/g, '').trim();
    console.log('AI response:', text);

    const item = JSON.parse(text);
    return res.status(200).json(item);

  } catch (error) {
    console.error('Handler error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
