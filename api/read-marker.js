// Vision-assisted fallback for CAD marker images Tesseract's pattern-matching OCR
// couldn't read cleanly, even after the client-side crop/contrast escalation (see
// parseMarkerFromImage in index.html). A real vision model reads small, anti-aliased
// screenshot text far more reliably than character-pattern OCR. Uses Google's Gemini
// API specifically because it has a genuinely free tier (no card required) -- this is
// a rare fallback path (Tesseract already handles the common case), so free-tier rate
// limits are fine; the client only calls this once Tesseract has already given up on
// every crop, never on every marker upload.
const GEMINI_MODEL = 'gemini-2.5-flash';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'AI-assisted marker reading is not configured (missing GEMINI_API_KEY)' });
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
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 500 },
        }),
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      res.status(502).json({ error: `Vision API error: ${resp.status} ${errText.slice(0, 300)}` });
      return;
    }
    const data = await resp.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || '').join('').trim();
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
