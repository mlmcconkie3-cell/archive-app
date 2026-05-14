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
    const { image } = req.body;

    if (!image) {
      console.error('No image in request body');
      return res.status(400).json({ error: 'No image provided' });
    }

    if (!process.env.OPENAI_KEY) {
      console.error('OPENAI_KEY environment variable not set');
      return res.status(500).json({ error: 'API key not configured' });
    }

    console.log('Sending image to OpenAI, base64 length:', image.length);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${image}` }
            },
            {
              type: 'text',
              text: `You are an expert collectibles appraiser. Identify this item and return ONLY valid JSON with no markdown backticks:
{"name":"full item name","sub":"year, edition, key details","cat":"Trading Card or Sneaker or Watch or Sports Card or Coin or Other","cond":"Mint or Near Mint or Very Good or Good or Fair or Poor","val":estimated_usd_number,"conf":"confidence like 94%"}
If unsure, return best guess with low confidence.`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    console.log('OpenAI response status:', response.status);

    if (data.error) {
      console.error('OpenAI error:', JSON.stringify(data.error));
      return res.status(500).json({ error: data.error.message });
    }

    if (!data.choices || !data.choices[0]) {
      console.error('No choices in response:', JSON.stringify(data));
      return res.status(500).json({ error: 'No response from AI' });
    }

    const text = data.choices[0].message.content.replace(/```json|```/g, '').trim();
    console.log('AI response text:', text);

    const item = JSON.parse(text);
    return res.status(200).json(item);

  } catch (error) {
    console.error('Handler error:', error.message, error.stack);
    return res.status(500).json({ error: error.message });
  }
}
