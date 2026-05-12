export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMime, extras = {}, action, skuData } = req.body;

  const IMGBB_KEY     = process.env.IMGBB_KEY;
  const SERP_KEY      = process.env.SERP_KEY;
  const CLAUDE_KEY    = process.env.CLAUDE_KEY;
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

  const sbFetch = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });

  // ── SKU 적재 액션 ──────────────────────────────────
  if (action === 'save_sku') {
    try {
      const r = await sbFetch('sku_items', {
        method: 'POST',
        prefer: 'return=representation',
        body: JSON.stringify(skuData)
      });
      const d = await r.json();
      return res.status(200).json({ success: true, data: d });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── SKU 목록 조회 액션 ─────────────────────────────
  if (action === 'list_sku') {
    try {
      const r = await sbFetch('sku_items?select=*&order=created_at.desc&limit=100');
      const d = await r.json();
      return res.status(200).json({ success: true, data: d });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── SKU 삭제 액션 ──────────────────────────────────
  if (action === 'delete_sku') {
    try {
      await sbFetch(`sku_items?id=eq.${skuData.id}`, { method: 'DELETE', prefer: '' });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── 메인 검수 플로우 ───────────────────────────────
  if (!imageBase64) return res.status(400).json({ error: '이미지가 없습니다' });

  try {
    // 1. imgbb + Claude 동시 실행
    const form = new URLSearchParams();
    form.append('key', IMGBB_KEY);
    form.append('image', imageBase64);

    const imageContents = [
      { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: '본품 전체샷' }
    ];
    for (const [key, b64] of Object.entries(extras)) {
      if (b64) {
        imageContents.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
        imageContents.push({ type: 'text', text: key });
      }
    }

    const [imgbbRes, claudeRes] = await Promise.all([
      fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form }),
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: `명품·패션 감정사. 사진 보고 JSON만 응답. 다른 텍스트 절대 금지.
{"brand":"영문브랜드명","category":"가방/의류/시계/쥬얼리/벨트/모자/신발/기타","model_name":"영문모델명","model_name_ko":"한글모델명(없으면null)","sku":null,"color":"색상","size":null,"confidence":85,"verdict":"pass","verdict_reason":"판정근거한줄","price_range":"참고가격","origin":null,"authenticity_notes":"확인포인트"}
verdict: pass/review/fail, confidence: 0-100 정수`,
          messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: 'JSON만 응답' }] }]
        })
      })
    ]);

    const imgbbJson = await imgbbRes.json();
    if (!imgbbJson.success) throw new Error('imgbb 업로드 실패');
    const imageUrl = imgbbJson.data.url;

    const claudeJson = await claudeRes.json();
    if (claudeJson.error) throw new Error('Claude 오류: ' + claudeJson.error.message);
    const raw = claudeJson.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // 2. Supabase DB 조회 (브랜드 + 모델명 매칭)
    let dbMatch = null;
    if (analysis.brand && analysis.model_name) {
      try {
        const brand = encodeURIComponent(analysis.brand);
        const model = encodeURIComponent(analysis.model_name);
        const dbRes = await sbFetch(
          `sku_items?brand=ilike.${brand}&model_name=ilike.${model}&limit=1`
        );
        const dbData = await dbRes.json();
        if (Array.isArray(dbData) && dbData.length > 0) dbMatch = dbData[0];
      } catch (e) { console.warn('DB 조회 실패:', e.message); }
    }

    // 3. SerpApi Google Lens (별도, 실패 무관)
    let visualMatches = [];
    try {
      const serpRes = await fetch(
        `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SERP_KEY}`
      );
      const lensData = await serpRes.json();
      visualMatches = lensData.visual_matches || [];
    } catch (e) { console.warn('SerpApi skip'); }

    return res.status(200).json({
      success: true,
      imageUrl,
      analysis,
      dbMatch,
      visualMatches: visualMatches.slice(0, 12)
    });

  } catch (err) {
    console.error('error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
