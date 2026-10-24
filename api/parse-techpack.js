// AI-assisted Tech Pack BOM extraction for the Costing tab. The client extracts the
// tech pack PDF's text itself (pdf.js, first ~12 pages — the Fabric/Trim/Packaging
// BOM always sits on an early "Summary" page) and sends just that text here, so the
// request stays small regardless of how large the original PDF is. Uses the same
// Gemini API + key already configured for AI-assisted marker reading (read-marker.js)
// rather than a second provider/key.
const GEMINI_MODEL = 'gemini-3.6-flash';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'AI-assisted tech pack reading is not configured (missing GEMINI_API_KEY)' });
    return;
  }
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const prompt = `You are reading the text extracted from a garment tech pack (an apparel spec document), typically from its "Summary" page(s). It normally has a header section identifying the style (Style/Dev code, Name, Description, Season, Year, Size range / Size-Sample), followed by a "Fabric BOM", a "Trim BOM", and a "Packaging BOM" (sometimes called "Labels & packaging"), each a table of items.

Extract everything you can find and respond with ONLY a single JSON object -- no other text, no markdown code fences, no explanation:

{
  "header": {"style": string or null, "description": string or null, "sizeRange": string or null, "season": string or null},
  "fabricItems": [{"name": string, "spec": string or null}],
  "trimItems": [{"name": string, "spec": string or null}],
  "packagingItems": [{"name": string, "spec": string or null}]
}

Header field meanings:
- style: the style / dev reference code printed near the top of the document (e.g. "LCG-PL 7865", "LCB-PL 7044"). Use null if none is visible.
- description: the garment's name/description as printed (e.g. "CORE POLO" and/or "MADE FOR OUTLETS" combined into one short line if both are present, otherwise whichever one is present). Use null if neither is visible.
- sizeRange: the size / sample range as printed (e.g. "1A-7A", "TODDLER CHILD LACOSTE (1A-7A)"). If multiple size groups are listed, use the one that looks like the primary/first size range rather than concatenating all of them. Use null if none is visible.
- season: season and/or year if printed together (e.g. "Fall 2026"). Use null if neither is visible.
- Only fill a header field from text that is clearly a label/value pair or an obvious document header -- never guess or infer one from context.

BOM field meanings:
- name: the item's own name exactly as printed (e.g. "LACOSTE MAIN LOOP LABEL", "LACOSTE 1X1 FLAT KNIT COLLAR + CUFF", "T0586 LT WT INTERFACING"). Keep buyer/style reference codes that are part of the item's identity if present, but drop ones that are clearly just a loose cross-reference column value sitting apart from the name.
- spec: a short extra descriptor if one is clearly attached to that same item (fiber content, construction, color/finish, vendor) -- e.g. "60% COTTON / 40% POLYESTER, 175 g/m2" or "GRITTI GROUP, IMINACRE". Use null if nothing extra is attached.
- fabricItems: rows from the Fabric BOM table only (the actual shell/body fabrics and any knit components grouped with it, e.g. a collar/cuff fabric).
- trimItems: rows from the Trim BOM table (elastic, interfacing, thread, buttons, embroidered logos, zippers, etc.) -- NOT fabrics, NOT labels/hangtags/packaging.
- packagingItems: rows from the Packaging BOM / "Labels & packaging" table (labels, hangtags, cord, polybag, cardboard, tissue paper, stickers, cartons, etc.).

Rules:
- Only include a row if it is a genuine, named item from one of these three tables. Never include page footers, column headers ("Ref no", "Dev code", "Vendor", "Quantity", "Location", "Construction", "Weight/Width", "Finish", "Coated" etc.), copyright notices, or bare reference/dev codes with no real item name attached to them.
- Do not invent, guess, or add any item that is not actually present in the text.
- Do not include quantities, usage percentages, or prices anywhere in the output -- those are entered separately by the user, not extracted here.
- If a table genuinely has no rows in this text (e.g. it was cut off), return an empty array for it rather than guessing.

Tech pack text:
"""
${text.slice(0, 60000)}
"""`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } },
        }),
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('parse-techpack: Gemini API error', resp.status, errText);
      res.status(502).json({ error: `AI API error: ${resp.status} ${errText.slice(0, 300)}` });
      return;
    }
    const data = await resp.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const textOut = parts.map((p) => p.text || '').join('').trim();
    const jsonMatch = textOut.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('parse-techpack: no parseable JSON in Gemini response', JSON.stringify(data).slice(0, 2000));
      res.status(502).json({ error: 'AI did not return parseable JSON' });
      return;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const h = parsed.header || {};
    res.status(200).json({
      ok: true,
      header: {
        style: h.style || null,
        description: h.description || null,
        sizeRange: h.sizeRange || null,
        season: h.season || null,
      },
      fabricItems: Array.isArray(parsed.fabricItems) ? parsed.fabricItems : [],
      trimItems: Array.isArray(parsed.trimItems) ? parsed.trimItems : [],
      packagingItems: Array.isArray(parsed.packagingItems) ? parsed.packagingItems : [],
    });
  } catch (e) {
    console.error('parse-techpack: unexpected error', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
