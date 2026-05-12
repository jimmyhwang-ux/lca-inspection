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

  // ── SKU 수정 액션 ──────────────────────────────────
  if (action === 'update_sku') {
    try {
      const { id, ...fields } = skuData;
      const r = await sbFetch(`sku_items?id=eq.${id}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify(fields)
      });
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

    // 2. Supabase DB 조회 - 전체 가져온 후 JS에서 유사도 매칭
    let dbMatch = null;
    if (analysis.brand) {
      try {
        // 전체 목록 가져와서 JS에서 매칭 (인코딩 이슈 우회)
        const dbRes = await sbFetch('sku_items?select=*&limit=500');
        const dbData = await dbRes.json();
        if (Array.isArray(dbData) && dbData.length > 0) {
          const aiBrand  = (analysis.brand || '').toLowerCase().trim();
          const aiModel  = (analysis.model_name || '').toLowerCase().trim();
          const aiModelKo= (analysis.model_name_ko || '').toLowerCase().trim();
          const aiSku    = (analysis.sku || '').toLowerCase().trim();

          let bestScore = 0;
          for (const item of dbData) {
            let score = 0;
            const dbBrand   = (item.brand || '').toLowerCase().trim();
            const dbModel   = (item.model_name || '').toLowerCase().trim();
            const dbModelKo = (item.model_name_ko || '').toLowerCase().trim();
            const dbSku     = (item.sku_code || '').toLowerCase().trim();

            // 브랜드 불일치면 스킵
            if (!dbBrand.includes(aiBrand) && !aiBrand.includes(dbBrand)) continue;

            // SKU 코드 완전 일치 → 최고점
            if (aiSku && dbSku && aiSku === dbSku) score += 100;

            // 모델명 매칭
            if (aiModel && dbModel) {
              if (aiModel === dbModel) score += 80;
              else if (dbModel.includes(aiModel) || aiModel.includes(dbModel)) score += 50;
              else {
                const w1 = aiModel.split(/\s+/).filter(w => w.length > 1);
                const w2 = dbModel.split(/\s+/).filter(w => w.length > 1);
                const overlap = w1.filter(w => w2.includes(w)).length;
                if (overlap > 0) score += overlap * 15;
              }
            }
            // 한글 모델명 매칭
            if (aiModelKo && dbModelKo) {
              if (aiModelKo === dbModelKo) score += 60;
              else if (dbModelKo.includes(aiModelKo) || aiModelKo.includes(dbModelKo)) score += 30;
            }
            // 브랜드만이라도 일치하면 기본 5점
            score += 5;

            if (score > bestScore) { bestScore = score; dbMatch = item; }
          }
          // 10점 미만은 매칭 실패
          if (bestScore < 10) dbMatch = null;
        }
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
