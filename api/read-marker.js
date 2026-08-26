// Vision-assisted fallback for CAD marker images Tesseract's pattern-matching OCR
// couldn't read cleanly, even after the client-side crop/contrast escalation (see
// parseMarkerFromImage in index.html). A real vision model reads small, anti-aliased
// screenshot text far more reliably than character-pattern OCR -- at the cost of a
// per-call API charge, which is why the client only calls this once Tesseract has
// already given up, not on every marker upload.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'AI-assisted marker reading is not configured (missing ANTHROPIC_API_KEY)' });
    return;
  }
  const { imageBase64, mimeType, fileName } = req.body || {};
  if (!imageBase64 || !mimeType) {
    res.status(400).json({ error: 'imageBase64 and mimeType are required' });
    return;
  }

  const prompt = `You are reading a CAD marker-making export (a garment cutting-marker image or a screenshot of marker-nesting software). Extract these fields and respond with ONLY a single JSON object -- no other text, no markdown code fences, no explanation:

{
  "styleName": string or null,
  "material": string or null,
  "unitSystem": "yard" or "metric" or null,
  "lengthBig": number or null,
  "widthSmall": number or null,
  "efficiency": number or null,
  "sizes": string or null,
  "sets": number or null
}

Field meanings:
- lengthBig: the marker's total length -- in YARDS if unitSystem is "yard", in METERS if unitSystem is "metric".
- widthSmall: the marker's cuttable width -- in INCHES if unitSystem is "yard", in CENTIMETERS if unitSystem is "metric".
- efficiency: the marker efficiency/utilization percentage, e.g. 82.86 (not 0.8286).
- sizes: the per-size piece-count breakdown as "SIZE/QTY" pairs separated by ", " -- e.g. "S/2, M/4, L/6". Null if no breakdown is visible anywhere in the image.
- sets: total piece count -- must equal the sum of the quantities in "sizes" when sizes is present.

Rules:
- Only fill a field if you can read it with high confidence from the actual pixels. Use null for anything ambiguous, cut off, blurry, or not visible -- never guess a digit or invent a plausible-looking number.
- The marker's data may appear as a labeled paragraph (e.g. "Length:...", "Width:...", "Model/Size/Qty:...", "Utilization:...") or as a short-code status bar from nesting software (e.g. "MD:" for style, "LN:" for length like "8Y 20.543I" meaning 8 yards 20.543 inches, "WI:" for width, "CU:" for efficiency/utilization). A per-size breakdown may only appear in a separate "Marker Properties" dialog box if one happens to be visible in the image -- if no such dialog and no size breakdown printed elsewhere, sizes and sets are both null.
- If lengthBig and widthSmall appear printed in different unit systems from each other on the same marker, convert widthSmall onto lengthBig's unit system (1 inch = 2.54 cm) and set unitSystem to match lengthBig's original unit.
- File name, for context only -- do not treat it as more reliable than what you actually read in the image: ${fileName || 'unknown'}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      res.status(502).json({ error: `Vision API error: ${resp.status} ${errText.slice(0, 300)}` });
      return;
    }
    const data = await resp.json();
    const text = (data.content || []).map((b) => b.text || '').join('').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(502).json({ error: 'Vision API did not return parseable JSON' });
      return;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
