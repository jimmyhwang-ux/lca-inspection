// Vercel 함수 타임아웃 60초로 설정 (기본 10초 → 초과 시 Overloaded처럼 보임)
export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMime, extras = {}, action, skuData } = req.body;

  const IMGBB_KEY    = process.env.IMGBB_KEY;
  const SERP_KEY     = process.env.SERP_KEY;
  const CLAUDE_KEY   = process.env.CLAUDE_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  // 접근 토큰 검증 (check_password 액션은 제외)
  if (action !== 'check_password') {
    const token = req.headers['x-access-token'];
    const ACCESS_PW = process.env.ACCESS_PASSWORD || 'lca2024';
    if (token !== ACCESS_PW) {
      return res.status(401).json({ success: false, error: '인증 필요' });
    }
  }

  // Supabase 요청 헬퍼 — Range 헤더로 1000행 기본 제한 해제
  const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Range-Unit': 'items',
      'Range': '0-9999',
      'Prefer': opts.prefer ?? 'return=representation',
      ...(opts.headers || {})
    }
  });

  // imgbb 업로드 헬퍼
  const uploadImgbb = async (b64) => {
    const form = new URLSearchParams();
    form.append('key', IMGBB_KEY);
    form.append('image', b64);
    const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const j = await r.json();
    if (!j.success) throw new Error('imgbb 실패');
    return j.data.url;
  };

  // ── 비밀번호 확인 ──────────────────────────────────
  if (action === 'check_password') {
    const ACCESS_PW = process.env.ACCESS_PASSWORD || 'lca2024';
    const { password } = req.body;
    if (password === ACCESS_PW) return res.status(200).json({ success: true });
    return res.status(200).json({ success: false });
  }

  // ── SKU 저장 ──────────────────────────────────────
  if (action === 'save_sku') {
    try {
      let extra_images = skuData.extra_images || [];
      if (skuData.newImageBase64) {
        const url = await uploadImgbb(skuData.newImageBase64);
        extra_images = [...extra_images, url];
      }
      const { source: _src, ...rest } = req.body;
      const srcVal = _src || 'model';
      const payload = { ...skuData, extra_images, source: srcVal };
      delete payload.newImageBase64;
      const r = await sb('sku_items', { method: 'POST', body: JSON.stringify(payload) });
      const d = await r.json();
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── SKU 목록 ──────────────────────────────────────
  if (action === 'list_sku') {
    try {
      const srcParam = req.body.source;
      let query = 'sku_items?select=*&order=created_at.desc&limit=10000';
      if (srcParam === 'db') {
        query += '&source=eq.db';
      } else if (srcParam === 'gear') {
        query += '&source=eq.gear';
      } else if (srcParam === 'model') {
        query += '&source=eq.model';
      }
      const r = await sb(query);
      const d = await r.json();
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── SKU 수정 ──────────────────────────────────────
  if (action === 'update_sku') {
    try {
      const { id, newImageBase64, ...fields } = skuData;
      if (newImageBase64) {
        const url = await uploadImgbb(newImageBase64);
        fields.extra_images = [...(fields.extra_images || []), url];
        if (!fields.ref_image_url) fields.ref_image_url = url;
      }
      const r = await sb(`sku_items?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
      const d = await r.json();
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── SKU 삭제 ──────────────────────────────────────
  if (action === 'delete_sku') {
    try {
      await sb(`sku_items?id=eq.${skuData.id}`, { method: 'DELETE', prefer: '' });
      return res.status(200).json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── 이미지 단건 업로드 ────────────────────────────
  if (action === 'upload_image') {
    try {
      const { imageBase64: b64 } = req.body;
      const url = await uploadImgbb(b64);
      return res.status(200).json({ url });
    } catch (e) {
      return res.status(500).json({ url: '', error: e.message });
    }
  }

  // ── 모델명으로 Google 재검색 ────────────────────────
  if (action === 'search_by_model') {
    try {
      const { brand, modelName } = req.body;
      if (!modelName) return res.status(200).json({ success: false, error: '이미지 없음' });
      const q = encodeURIComponent(`${brand||''} ${modelName}`.trim());
      const s = await fetch(`https://serpapi.com/search?engine=google_shopping&q=${q}&api_key=${SERP_KEY}&num=10`);
      const j = await s.json();
      const results = j.shopping_results || j.organic_results || [];
      const visualMatches = results.slice(0, 12).map(r => ({
        title: r.title || '',
        link: r.link || r.product_link || '',
        thumbnail: r.thumbnail || r.image || '',
        price: r.price || '',
        source: r.source || r.merchant?.name || '',
      }));
      return res.status(200).json({ success: true, visualMatches });
    } catch(e) {
      return res.status(200).json({ success: false, error: e.message });
    }
  }

  // ── 모델명 한글→영문 직역 ─────────────────────────
  if (action === 'translate_model') {
    try {
      const { modelNameKo } = req.body;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 60,
          messages: [{
            role: 'user',
            content: `Translate this Korean luxury product model name to English. Output the English translation only, one line, no explanation.\nKorean: ${modelNameKo}`
          }]
        })
      });
      const j = await r.json();
      const en = (j.content?.[0]?.text || '').trim().split('\n')[0];
      return res.status(200).json({ model_name_en: en });
    } catch (e) {
      return res.status(500).json({ model_name_en: '' });
    }
  }

  // ── 메인 검수 ─────────────────────────────────────
  if (!imageBase64) return res.status(400).json({ error: '이미지 없음' });

  try {
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

    const claudePromise = fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: `명품·패션 감정사. 사진 보고 JSON만 응답. 다른 텍스트 절대 금지.
{"brand":"영문브랜드명","category":"가방/의류/시계/쥬얼리/벨트/모자/신발/기타","model_name":"영문모델명","model_name_ko":"한글모델명(없으면null)","sku":null,"color":"색상","size":null,"confidence":85,"verdict":"pass","verdict_reason":"판정근거한줄","price_range":"참고가격","origin":null,"authenticity_notes":"확인포인트"}
verdict: pass/review/fail, confidence: 0-100 정수`,
        messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: 'JSON만 응답' }] }]
      })
    }).then(r => r.json());

    const imgbbPromise = uploadImgbb(imageBase64);

    const dbPromise = sb('sku_items?select=*&order=created_at.desc&limit=10000')
      .then(r => r.json())
      .catch(() => []);

    const [claudeRes, imageUrl, dbData] = await Promise.all([
      claudePromise,
      imgbbPromise,
      dbPromise,
    ]);

    if (claudeRes.error) {
      const msg = claudeRes.error.message || '';
      throw new Error('Claude 오류: ' + msg);
    }
    const raw = claudeRes.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // DB 매칭
    let dbMatch = null;
    try {
      if (Array.isArray(dbData) && dbData.length > 0) {
        const aiBrand   = (analysis.brand || '').toLowerCase().trim();
        const aiModel   = (analysis.model_name || '').toLowerCase().trim();
        const aiModelKo = (analysis.model_name_ko || '').toLowerCase().trim();
        const aiSku     = (analysis.sku || '').toLowerCase().trim();

        const candidates = [];
        for (const item of dbData) {
          const dbBrand   = (item.brand || '').toLowerCase().trim();
          const dbModel   = (item.model_name || '').toLowerCase().trim();
          const dbModelKo = (item.model_name_ko || '').toLowerCase().trim();
          const dbSku     = (item.sku_code || '').toLowerCase().trim();

          if (aiBrand && dbBrand && !dbBrand.includes(aiBrand) && !aiBrand.includes(dbBrand)) continue;
          if (aiSku && dbSku && aiSku === dbSku) { candidates.push({item, score: 200}); continue; }

          let score = 0;
          if (aiModel && dbModel) {
            if (aiModel === dbModel) score = 100;
            else if (dbModel.includes(aiModel) || aiModel.includes(dbModel)) score = 60;
            else {
              const w1 = aiModel.split(' ').filter(w => w.length >= 2);
              const w2 = dbModel.split(' ').filter(w => w.length >= 2);
              if (w1.length > 0) {
                const hits = w1.filter(w => w2.includes(w)).length;
                const ratio = hits / w1.length;
                if (ratio >= 0.6) score = Math.round(ratio * 50);
              }
            }
          }
          if (aiModelKo && dbModelKo) {
            if (aiModelKo === dbModelKo) score = Math.max(score, 90);
            else if (dbModelKo.includes(aiModelKo) || aiModelKo.includes(dbModelKo)) score = Math.max(score, 55);
          }
          if (score >= 50) candidates.push({item, score});
        }

        if (candidates.length > 0) {
          const maxScore = Math.max(...candidates.map(c => c.score));
          const topCandidates = candidates.filter(c => c.score === maxScore);
          const withNotes = topCandidates.find(c => c.item.notes && c.item.notes.trim());
          dbMatch = (withNotes || topCandidates[0]).item;
        }
      }
    } catch (e) { console.warn('DB skip:', e.message); }

    // Google Lens — 타임아웃 방지를 위해 5초 제한
    let visualMatches = [];
    try {
      const lensController = new AbortController();
      const lensTimeout = setTimeout(() => lensController.abort(), 5000);
      const s = await fetch(
        `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SERP_KEY}`,
        { signal: lensController.signal }
      );
      clearTimeout(lensTimeout);
      const j = await s.json();
      visualMatches = j.visual_matches || [];
    } catch (e) { console.warn('Lens skip:', e.message); }

    if (dbMatch) {
      dbMatch = {
        ...dbMatch,
        extra_images: Array.isArray(dbMatch.extra_images) ? dbMatch.extra_images : [],
        ref_image_url: dbMatch.ref_image_url || null,
      };
    }

    return res.status(200).json({
      success: true, imageUrl, analysis, dbMatch,
      visualMatches: visualMatches.slice(0, 12)
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
