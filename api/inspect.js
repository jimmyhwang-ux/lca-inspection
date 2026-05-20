export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMime, extras = {}, action, skuData } = req.body;

  const IMGBB_KEY    = process.env.IMGBB_KEY;
  const SERP_KEY     = process.env.SERP_KEY;
  const CLAUDE_KEY   = process.env.CLAUDE_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (action !== 'check_password') {
    const token = req.headers['x-access-token'];
    const ACCESS_PW = process.env.ACCESS_PASSWORD || 'lca2024';
    if (token !== ACCESS_PW) return res.status(401).json({ success: false, error: '인증 필요' });
  }

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

  const uploadImgbb = async (b64) => {
    const form = new URLSearchParams();
    form.append('key', IMGBB_KEY);
    form.append('image', b64);
    const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const j = await r.json();
    if (!j.success) throw new Error('imgbb 실패');
    return j.data.url;
  };

  if (action === 'check_password') {
    const ACCESS_PW = process.env.ACCESS_PASSWORD || 'lca2024';
    const { password } = req.body;
    return res.status(200).json({ success: password === ACCESS_PW });
  }

  if (action === 'save_sku') {
    try {
      let extra_images = skuData.extra_images || [];
      if (skuData.newImageBase64) {
        const url = await uploadImgbb(skuData.newImageBase64);
        extra_images = [...extra_images, url];
      }
      const srcVal = req.body.source || 'model';
      const payload = { ...skuData, extra_images, source: srcVal };
      delete payload.newImageBase64;
      const r = await sb('sku_items', { method: 'POST', body: JSON.stringify(payload) });
      const d = await r.json();
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  if (action === 'list_sku') {
    try {
      const srcParam = req.body.source;
      let query = 'sku_items?select=*&order=created_at.desc&limit=10000';
      if (srcParam === 'gear') query += '&source=eq.gear';
      // gear 외엔 source 필터 없이 전체 조회 (다른 사람 데이터 포함)
      const r = await sb(query);
      const d = await r.json();
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  if (action === 'update_sku') {
    try {
      const { id, newImageBase64, ...fields } = skuData;
      if (!id) return res.status(400).json({ success: false, error: 'id 없음' });
      if (newImageBase64) {
        const url = await uploadImgbb(newImageBase64);
        fields.extra_images = [...(fields.extra_images || []), url];
        if (!fields.ref_image_url) fields.ref_image_url = url;
      }
      if (fields.accessories && !Array.isArray(fields.accessories)) fields.accessories = [];
      const r = await sb(`sku_items?id=eq.${id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify(fields)
      });
      if (r.status === 204 || r.status === 200) return res.status(200).json({ success: true });
      const d = await r.json();
      if (d.code || d.message) return res.status(200).json({ success: false, error: d.message || JSON.stringify(d) });
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  if (action === 'delete_sku') {
    try {
      await sb(`sku_items?id=eq.${skuData.id}`, { method: 'DELETE', prefer: '' });
      return res.status(200).json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  if (action === 'upload_image') {
    try {
      const url = await uploadImgbb(req.body.imageBase64);
      return res.status(200).json({ url });
    } catch (e) { return res.status(500).json({ url: '', error: e.message }); }
  }

  if (action === 'search_by_model') {
    try {
      const { brand, modelName } = req.body;
      if (!modelName) return res.status(200).json({ success: false, error: '모델명 없음' });
      const q = encodeURIComponent(`${brand||''} ${modelName}`.trim());
      const s = await fetch(`https://serpapi.com/search?engine=google_shopping&q=${q}&api_key=${SERP_KEY}&num=10`);
      const j = await s.json();
      const results = j.shopping_results || j.organic_results || [];
      const visualMatches = results.slice(0, 12).map(r => ({
        title: r.title||'', link: r.link||r.product_link||'',
        thumbnail: r.thumbnail||r.image||'', price: r.price||'',
        source: r.source||r.merchant?.name||'',
      }));
      return res.status(200).json({ success: true, visualMatches });
    } catch(e) { return res.status(200).json({ success: false, error: e.message }); }
  }

  if (action === 'translate_model') {
    try {
      const { modelNameKo } = req.body;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-3-20240307', max_tokens: 60,
          messages: [{ role: 'user', content: `Translate this Korean luxury product model name to English. Output the English translation only, one line, no explanation.\nKorean: ${modelNameKo}` }]
        })
      });
      const j = await r.json();
      return res.status(200).json({ model_name_en: (j.content?.[0]?.text||'').trim().split('\n')[0] });
    } catch (e) { return res.status(500).json({ model_name_en: '' }); }
  }

  // ── 메인 검수 ─────────────────────────────────────────────────
  if (!imageBase64) return res.status(400).json({ error: '이미지 없음' });

  try {
    const imageContents = [
      { type: 'image', source: { type: 'base64', media_type: imageMime||'image/jpeg', data: imageBase64 } },
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-3-20240307', max_tokens: 800,
        system: `명품·패션 감정사. 사진 보고 JSON만 응답. 다른 텍스트 절대 금지.
{"brand":"영문브랜드명","category":"가방/의류/시계/쥬얼리/벨트/모자/신발/기타","model_name":"영문모델명","model_name_ko":"한글모델명(없으면null)","sku":null,"color":"색상","size":null,"confidence":85,"verdict":"pass","verdict_reason":"판정근거한줄","price_range":"참고가격","origin":null,"authenticity_notes":"확인포인트"}
verdict: pass/review/fail, confidence: 0-100 정수`,
        messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: 'JSON만 응답' }] }]
      })
    }).then(r => r.json());

    const imgbbPromise = uploadImgbb(imageBase64).catch(e => {
      console.warn('[imgbb 실패]', e.message); return ''; // 실패해도 계속 진행
    });
    const dbPromise = sb('sku_items?select=*&order=created_at.desc&limit=10000')
      .then(async r => {
        const data = await r.json();
        console.log('[DB]', r.status, Array.isArray(data)?data.length:'ERR:'+JSON.stringify(data).slice(0,80));
        return Array.isArray(data) ? data : [];
      })
      .catch(e => { console.error('[DB fetch error]', e.message); return []; });

    const [claudeRes, imageUrl, dbData] = await Promise.all([claudePromise, imgbbPromise, dbPromise]);

    if (claudeRes.error) throw new Error('Claude 오류: ' + (claudeRes.error.message||''));
    const raw = claudeRes.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

  // ── 한글↔영문 브랜드 매핑 ────────────────────────────────────
  const BRAND_MAP = {
    'gucci':'구찌','louisvuitton':'루이비통','louisvuitton':'루이비통',
    'hermes':'에르메스','chanel':'샤넬','dior':'디올','prada':'프라다',
    'balenciaga':'발렌시아가','saintlaurent':'생로랑','ysl':'생로랑',
    'bottegaveneta':'보테가베네타','celine':'셀린느','loewe':'로에베',
    'fendi':'펜디','valentino':'발렌티노','givenchy':'지방시',
    'burberry':'버버리','moncler':'몽클레어','thombrowne':'톰브라운',
    'miumiu':'미우미우','maisonmargiela':'메종마르지엘라',
    'goyard':'고야드','delvaux':'델보','cartier':'까르띠에',
    'rolex':'롤렉스','omega':'오메가','tagheuer':'태그호이어',
    'patekphilippe':'파텍필립','audemarspiguet':'오데마피게',
    'iwc':'아이더블유씨','breitling':'브라이틀링',
    'bulgari':'불가리','bvlgari':'불가리','tiffany':'티파니',
    'vancleefarpe':'반클리프','chaumet':'쇼메','fred':'프레드',
    'ferragamo':'페라가모','mulberry':'멀버리','coach':'코치',
    'hamilton':'해밀턴','tissot':'티쏘','longines':'론진',
    'frederiqueconstant':'프레드릭 콘스탄트',
    'tiffanyco':'티파니앤코','tiffany&co':'티파니앤코',
  };

  function normBrand(b) {
    return b.toLowerCase().replace(/[\s\-&·]/g, '');
  }

  function brandMatches(aiBrand, dbBrand) {
    if (!aiBrand || !dbBrand) return false;
    const ai = normBrand(aiBrand);
    const db = normBrand(dbBrand);
    if (db.includes(ai) || ai.includes(db)) return true;
    // 한글 → 영문 변환 후 비교
    const aiEn = BRAND_MAP[ai] ? normBrand(BRAND_MAP[ai]) : ai;
    const dbEn = BRAND_MAP[db] ? normBrand(BRAND_MAP[db]) : db;
    if (aiEn && dbEn && (aiEn.includes(dbEn) || dbEn.includes(aiEn))) return true;
    // 반대 방향도
    const aiFromDb = Object.entries(BRAND_MAP).find(([k,v]) => normBrand(v) === db)?.[0];
    if (aiFromDb && (ai.includes(aiFromDb) || aiFromDb.includes(ai))) return true;
    return false;
  }

    // ── DB 매칭 (브랜드 필수 일치 + 높은 점수 기준 강화) ─────────
    let dbMatches = [];
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

          // ── 브랜드 필수 일치 (한글↔영문 변환 포함) ──────────────
          if (!aiBrand || !dbBrand) continue;
          // Unknown 브랜드면 브랜드 필터 건너뜀 (모델명으로만 매칭)
          const isUnknownBrand = ['unknown','기타','알수없음','unidentified'].includes(aiBrand.toLowerCase());
          if (!isUnknownBrand && !brandMatches(aiBrand, dbBrand)) continue;

          // ── SKU 완전 일치: 최고 점수 ─────────────────────────────
          if (aiSku && dbSku && aiSku === dbSku) {
            candidates.push({ item, score: 200 });
            continue;
          }

          let score = 0;

          // ── 영문 모델명 매칭 ──────────────────────────────────────
          if (aiModel && dbModel) {
            if (aiModel === dbModel) score = 100;
            else if (dbModel.includes(aiModel) || aiModel.includes(dbModel)) score = 70;
            else {
              const w1 = aiModel.split(' ').filter(w => w.length >= 2);
              const w2 = dbModel.split(' ').filter(w => w.length >= 2);
              // 단어 1개라도 완전 포함이면 매칭 허용
              if (w1.length >= 1) {
                const hits = w1.filter(w => w2.includes(w)).length;
                const ratio = hits / w1.length;
                if (w1.length === 1 && hits === 1) score = Math.max(score, 60);
                else if (ratio >= 0.6) score = Math.round(ratio * 60);
              }
            }
          }

          // ── 한글 모델명 매칭 (토큰 단위) ─────────────────────────
          if (aiModelKo && dbModelKo) {
            if (aiModelKo === dbModelKo) {
              score = Math.max(score, 95);
            } else if (dbModelKo.includes(aiModelKo) || aiModelKo.includes(dbModelKo)) {
              score = Math.max(score, 70);
            } else {
              // 토큰 단위 매칭: "포셋 악세수아" → ['포셋','악세수아'] 중 하나라도 포함되면 매칭
              const koToks = aiModelKo.split(/\s+/).filter(w => w.length >= 2);
              if (koToks.length > 0) {
                const hits = koToks.filter(t => dbModelKo.includes(t)).length;
                if (hits > 0) {
                  score = Math.max(score, Math.round(60 + (hits / koToks.length) * 30));
                }
              }
            }
          }

          // 최소 점수 60 이상만 매칭
          if (score >= 60) candidates.push({ item, score });
        }

        if (candidates.length > 0) {
          // 점수 내림차순 정렬
          candidates.sort((a, b) => b.score - a.score);
          const maxScore = candidates[0].score;
          // 최고점 ±10점 이내만 표시 (너무 낮은 것 제외)
          const topCandidates = candidates.filter(c => c.score >= maxScore - 10);
          // 특이사항 있는 것 우선, 최대 5개
          topCandidates.sort((a, b) => {
            const aN = a.item.notes ? 1 : 0;
            const bN = b.item.notes ? 1 : 0;
            return bN - aN;
          });
          dbMatches = topCandidates.slice(0, 5).map(c => c.item);
        }
      }
    } catch (e) { console.warn('DB skip:', e.message); }

    // Google Lens
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

    // dbMatches 후처리
    dbMatches = dbMatches.map(m => ({
      ...m,
      extra_images: Array.isArray(m.extra_images) ? m.extra_images : [],
      ref_image_url: m.ref_image_url || null,
    }));

    return res.status(200).json({
      success: true, imageUrl, analysis,
      dbMatch: dbMatches[0] || null,
      dbMatches,
      visualMatches: visualMatches.slice(0, 12)
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
