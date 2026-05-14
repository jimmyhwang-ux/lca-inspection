export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMime, extras = {}, action, skuData } = req.body;

  const IMGBB_KEY    = process.env.IMGBB_KEY;
  const SERP_KEY     = process.env.SERP_KEY;
  const CLAUDE_KEY   = process.env.CLAUDE_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
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

  // ── 사이즈 파싱 헬퍼 ──────────────────────────────────────────────────
  // 인치 → cm 변환 (0.5 단위 반올림 — 예: 36.068 → 36, 23.114 → 23)
  function inchToCm(val) {
    const cm = parseFloat(val) * 2.54;
    // 0.5 단위 반올림: 소수점이 .25 미만이면 버림, .75 이상이면 올림, 나머지 0.5
    return Math.round(cm * 2) / 2;
  }

  // 숫자 파싱 + 인치면 cm 변환
  function normVal(numStr, isInch) {
    const n = parseFloat(numStr.replace(',', '.'));
    if (isNaN(n)) return null;
    return isInch ? inchToCm(n) : n;
  }

  // 치수값 현실성 검증 — 명품 패션 기준 2~80cm, 비율 8배 이내
  function isValidDimensions(parts) {
    const MAX = 80, MIN = 2;
    if (parts.some(v => v > MAX || v < MIN)) return false;
    const sorted = [...parts].sort((a, b) => b - a);
    if (sorted[0] / sorted[sorted.length - 1] > 8) return false;
    return true;
  }

  function parseSizeFromText(text) {
    if (!text) return null;

    // 인치 여부 판단
    const hasInch = /\d\s*(?:in|inch|inches|"|″)/i.test(text);
    const hasCm   = /\d\s*cm/i.test(text);
    const hasMm   = /\d\s*mm/i.test(text);
    const isInch  = hasInch && !hasCm;

    // 패턴0: "W:25.5cm H:20cm", "H: 20cm x W: 25.5cm", "Width: 9.8in Height: 7.9in" (레이블 명시형)
    {
      // Width/Height/Depth 풀네임을 단일 문자로 정규화
      const normText = text
        .replace(/width/gi,'W').replace(/height/gi,'H').replace(/depth/gi,'D')
        .replace(/length/gi,'L').replace(/large/gi,'');
      const labelRe = /([WHDLwhd])\s*:?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|mm|in|inch|inches)?/gi;
      const labelMap = {};
      let lm;
      while ((lm = labelRe.exec(normText)) !== null) {
        const key = lm[1].toLowerCase();
        const unit = (lm[3] || '').toLowerCase();
        const inchU = isInch || unit.startsWith('in');
        const mmU = unit === 'mm';
        let val = parseFloat(lm[2].replace(',', '.'));
        if (inchU) val = inchToCm(val);
        else if (mmU) val = Math.round(val / 10 * 10) / 10;
        labelMap[key] = val;
      }
      const wVal = labelMap['w'] || labelMap['l'];
      const hVal = labelMap['h'];
      if (wVal && hVal) {
        const dVal = labelMap['d'];
        const parts0 = [wVal, hVal, dVal].filter(Boolean);
        if (!isValidDimensions(parts0)) return null;
        const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
        return parts0.map(fmt).join(' × ') + ' cm';
      }
    }

    // 패턴1: "25.5 x 20 x 6.5 cm/in", "25×20×6", "9.8" x 7.9""
    const p1 = text.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:cm|mm|in|inch|inches|"|″)?\s*[x×*]\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:cm|mm|in|inch|inches|"|″)?(?:\s*[x×*]\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:cm|mm|in|inch|inches|"|″)?)?(?:\s*(cm|mm|in|inch|inches))?/i);
    if (p1) {
      const rawUnit = (p1[4] || '').toLowerCase();
      const unitIsInch = isInch || rawUnit.startsWith('in') || rawUnit === '"';
      const unitIsMm   = hasMm && !hasCm && !unitIsInch;
      const parts = [p1[1], p1[2], p1[3]]
        .filter(Boolean)
        .map(v => {
          const n = normVal(v, unitIsInch);
          if (n === null) return null;
          // mm → cm
          if (unitIsMm) return Math.round(n / 10 * 10) / 10;
          return n;
        })
        .filter(v => v !== null);
      if (parts.length < 2) return null;
      if (!isValidDimensions(parts)) return null;
      const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
      return parts.map(fmt).join(' × ') + ' cm';
    }

    // 패턴2: "W25 H20 D6", "W:9.8in H:7.9in", "H:20cm x W:25cm" (순서 무관)
    const p2 = text.match(/[WwLlHhDd][:\s]?(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|mm|in|inch|inches|"|″)?.{0,15}[WwLlHhDd][:\s]?(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|mm|in|inch|inches|"|″)?/i);
    if (p2) {
      const u1 = (p2[2] || '').toLowerCase().trim();
      const u2 = (p2[4] || '').toLowerCase().trim();
      const inch1 = isInch || u1.startsWith('in') || u1 === '"';
      const inch2 = isInch || u2.startsWith('in') || u2 === '"';
      const mm1 = u1 === 'mm'; const mm2 = u2 === 'mm';
      let v1 = normVal(p2[1], inch1); if (mm1 && v1) v1 = Math.round(v1/10*10)/10;
      let v2 = normVal(p2[3], inch2); if (mm2 && v2) v2 = Math.round(v2/10*10)/10;
      if (!v1 || !v2) return null;
      if (!isValidDimensions([v1, v2])) return null;
      const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
      return fmt(v1) + ' × ' + fmt(v2) + ' cm';
    }

    // 패턴3: "9.8 inches wide by 7.9 inches tall", "25cm wide by 20cm tall"
    const p3 = text.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|mm|in|inch|inches)?\s*(?:wide|width|long|length).{0,25}?(\d{1,3}(?:[.,]\d{1,2})?)\s*(cm|mm|in|inch|inches)?\s*(?:tall|high|height|deep|depth)/i);
    if (p3) {
      const u1 = (p3[2] || '').toLowerCase();
      const u2 = (p3[4] || '').toLowerCase();
      const inch1 = isInch || u1.startsWith('in');
      const inch2 = isInch || u2.startsWith('in');
      const v1 = normVal(p3[1], inch1);
      const v2 = normVal(p3[3], inch2);
      if (!v1 || !v2) return null;
      if (!isValidDimensions([v1, v2])) return null;
      const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
      return fmt(v1) + ' × ' + fmt(v2) + ' cm';
    }

    return null;
  }

  function parseSizeNameFromText(text) {
    if (!text) return null;
    const m = text.match(/\b(nano|micro|baby|mini|petite|small|medium|large|xl|maxi|pm|mm|gm|tpm|bph|xs|xxs)\b/i);
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : null;
  }

  function parseSkuFromText(text, brand) {
    if (!text) return null;
    const b = (brand || '').toLowerCase();

    // 브랜드별 스타일번호 패턴
    const patterns = [
      // LV: M + 5자리 숫자 (예: M58552, M57790)
      /\bM\d{5}\b/,
      // Dior: 영문2-3자 + 숫자3-4자 + 영문3자 + 숫자 (예: 2ESBC293ZH1, 1ADPO093)
      /\b[0-9][A-Z]{2,4}[A-Z0-9]{3,8}\b/,
      // Chanel: A + 숫자5자 (예: A01112, A93749)
      /\bA\d{5}\b/,
      // Gucci: 숫자6자 (예: 699406, 443497)
      /\b\d{6}\b/,
      // Hermès: H + 숫자6자 + 영문 (예: H071748M)
      /\bH\d{6}[A-Z]?\b/,
      // Prada: 영문1자 + 숫자4자 (예: B4458, 1BH204)
      /\b[0-9][A-Z]{2}\d{3}\b/,
      // 일반 스타일번호: 영문+숫자 혼합 6-12자
      /\b[A-Z]{1,3}[-_]?\d{4,8}\b/,
      /\b\d{1,2}[A-Z]{2,4}\d{3,6}[A-Z0-9]{0,4}\b/,
    ];

    // SKU/Style/Item/Reference 키워드 근처 우선 파싱
    const keyRe = /\b(style\s*(?:no|number|#)?|sku|item\s*(?:no|number|#)?|reference|ref\s*(?:no)?|model\s*(?:no|number)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_]{4,14})/gi;
    let km;
    while ((km = keyRe.exec(text)) !== null) {
      const candidate = km[2];
      if (/\d/.test(candidate) && /[A-Z0-9]/.test(candidate)) return candidate;
    }

    // 브랜드별 패턴 매칭
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) return m[0];
    }
    return null;
  }

  function majority(arr) {
    if (!arr.length) return null;
    const freq = {};
    for (const v of arr) freq[v] = (freq[v] || 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    // 최다 등장값이 2개 이상일 때만 신뢰
    return sorted[0][1] >= 2 ? sorted[0][0] : sorted[0][0];
  }

  // 페이지에서 사이즈 관련 텍스트 추출 (HTML → 후보 텍스트 블록들)
  function extractSizeTexts(html) {
    // script/style 제거
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    // 사이즈 관련 키워드 주변 텍스트 추출
    const candidates = [];
    const keywords = /\b(size|dimension|measurement|치수|사이즈|크기|실측|가로|세로|높이|width|height|depth|length)\b/gi;
    let m;
    while ((m = keywords.exec(clean)) !== null) {
      const snippet = clean.slice(Math.max(0, m.index - 30), m.index + 120);
      candidates.push(snippet);
    }
    // 숫자×숫자 패턴 직접 검색
    const directRe = /\d{1,3}\s*[x×*]\s*\d{1,3}/g;
    let dm;
    while ((dm = directRe.exec(clean)) !== null) {
      candidates.push(clean.slice(Math.max(0, dm.index - 20), dm.index + 80));
    }
    return candidates;
  }

  // ── fetch_size 액션 ───────────────────────────────────────────────────
  // fetch_size: 사이즈는 SKU DB에서 관리 — 이 액션은 미사용
  if (action === 'fetch_size') {
    return res.status(200).json({ success: true, size: null, size_label: null, sources: [] });
  }


  // ── SKU 저장 ──────────────────────────────────────────────────────────
  if (action === 'save_sku') {
    try {
      let extra_images = skuData.extra_images || [];
      if (skuData.newImageBase64) {
        const url = await uploadImgbb(skuData.newImageBase64);
        extra_images = [...extra_images, url];
      }
      const payload = { ...skuData, extra_images };
      delete payload.newImageBase64;
      // site_url: DB 컬럼 없으면 에러 방지 — 일단 전송하고 에러 시 제거 후 재시도
      if (payload.site_url === undefined) payload.site_url = '';
      const r = await sb('sku_items', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Prefer': 'return=representation' }
      });
      const text = await r.text();
      if (!r.ok) {
        let errMsg = text;
        try { errMsg = JSON.parse(text)?.message || text; } catch(_) {}
        // site_url 컬럼 없는 경우 제거 후 재시도
        if (r.status === 400 && errMsg.includes('site_url')) {
          delete payload.site_url;
          const r2 = await sb('sku_items', {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Prefer': 'return=representation' }
          });
          const text2 = await r2.text();
          if (!r2.ok) return res.status(200).json({ success: false, error: `저장 실패: ${text2}` });
          return res.status(200).json({ success: true, data: text2 ? JSON.parse(text2) : [] });
        }
        return res.status(200).json({ success: false, error: `Supabase 오류 ${r.status}: ${errMsg}` });
      }
      const d = text ? JSON.parse(text) : [];
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── SKU 목록 ──────────────────────────────────────────────────────────
  if (action === 'list_sku') {
    try {
      const r = await sb('sku_items?select=*&order=created_at.desc&limit=200');
      const d = await r.json();
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── SKU 수정 ──────────────────────────────────────────────────────────
  if (action === 'update_sku') {
    try {
      const { id, newImageBase64, ...fields } = skuData;
      if (newImageBase64) {
        const url = await uploadImgbb(newImageBase64);
        fields.extra_images = [...(fields.extra_images || []), url];
        if (!fields.ref_image_url) fields.ref_image_url = url;
      }
      if (!fields.site_url) fields.site_url = '';
      const r = await sb(`sku_items?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
        headers: { 'Prefer': 'return=representation' }
      });
      const text = await r.text();
      if (!r.ok) {
        let errMsg = text;
        try { errMsg = JSON.parse(text)?.message || text; } catch(_) {}
        return res.status(200).json({ success: false, error: `Supabase 오류 ${r.status}: ${errMsg}` });
      }
      const d = text ? JSON.parse(text) : [];
      return res.status(200).json({ success: true, data: d });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── SKU 삭제 ──────────────────────────────────────────────────────────
  if (action === 'delete_sku') {
    try {
      await sb(`sku_items?id=eq.${skuData.id}`, { method: 'DELETE', prefer: '' });
      return res.status(200).json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── 이미지 단건 업로드 ────────────────────────────────────────────────
  if (action === 'upload_image') {
    try {
      const { imageBase64: b64 } = req.body;
      const url = await uploadImgbb(b64);
      return res.status(200).json({ url });
    } catch (e) { return res.status(500).json({ url: '', error: e.message }); }
  }

  // ── 모델명으로 Google Images 재검색 ────────────────────────────────────
  if (action === 'search_by_model') {
    try {
      const { brand, modelName } = req.body;
      const query = [brand, modelName].filter(Boolean).join(' ');
      if (!query) return res.status(400).json({ success: false, error: 'query 없음' });

      const url = `https://serpapi.com/search?engine=google_images&q=${encodeURIComponent(query)}&gl=us&hl=en&api_key=${SERP_KEY}`;
      const r = await fetch(url);
      const j = await r.json();
      const images = (j.images_results || []).slice(0, 12).map(img => ({
        title:     img.title || '',
        link:      img.link  || img.original || '',
        thumbnail: img.thumbnail || img.original || '',
        source:    img.source || (img.link ? new URL(img.link).hostname : ''),
        price:     img.price || null,
      }));

      // 사이즈는 SKU DB에서 관리 — 자동 추출 안함

      return res.status(200).json({
        success: true,
        visualMatches: images,
        lensSize:     null,
        lensSizeName: null,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── 모델명 한글→영문 ──────────────────────────────────────────────────
  if (action === 'translate_model') {
    try {
      const { modelNameKo } = req.body;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 60,
          messages: [{ role: 'user', content: `Translate this Korean luxury product model name to English. Output the English translation only, one line, no explanation.\nKorean: ${modelNameKo}` }]
        })
      });
      const j = await r.json();
      const en = (j.content?.[0]?.text || '').trim().split('\n')[0];
      return res.status(200).json({ model_name_en: en });
    } catch (e) { return res.status(500).json({ model_name_en: '' }); }
  }

  // ── 메인 검수 ─────────────────────────────────────────────────────────
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

    const [imageUrl, claudeRes] = await Promise.all([
      uploadImgbb(imageBase64),
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: `명품·패션 감정사. 사진 보고 JSON만 응답. 다른 텍스트 절대 금지.
{"brand":"영문브랜드명","category":"가방/의류/시계/쥬얼리/벨트/모자/신발/기타","model_name":"영문모델명","model_name_ko":"한글모델명(없으면null)","sku":"스타일번호(라벨에 보이면)","color":"색상","size":"라벨/태그에 치수가 직접 보일때만 기재(예:11.5x9.5cm), 없으면 null","size_label":"Mini/Small/Medium/Large/PM/MM/GM 등 사이즈명칭(보일때만, 없으면null)","confidence":85,"verdict":"pass","verdict_reason":"판정근거한줄","price_range":"참고가격","origin":null,"authenticity_notes":"확인포인트"}
verdict: pass/review/fail, confidence: 0-100 정수. size는 반드시 이미지에서 직접 확인된 경우만 기재, 추측 금지.`,
          messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: 'JSON만 응답' }] }]
        })
      }).then(r => r.json())
    ]);

    if (claudeRes.error) throw new Error('Claude 오류: ' + claudeRes.error.message);
    const raw = claudeRes.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());



    // Google Lens
    let visualMatches = [];
    try {
      const s = await fetch(`https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SERP_KEY}`);
      const j = await s.json();
      visualMatches = j.visual_matches || [];
    } catch (e) { console.warn('Lens skip'); }

    // ── 스타일번호: 렌즈 타이틀에서 파싱 ─────────────────────────────
    // 사이즈/사이즈명칭은 SKU DB 매칭에서만 가져옴 (자동 추출 제거)
    let lensSize = null;
    let lensSizeName = null;
    let lensSizeSources = [];
    let lensSku = null;
    try {
      const brand = analysis.brand || '';
      // 렌즈 타이틀 전체 텍스트
      const lensTitles = visualMatches.slice(0, 10)
        .map(m => m.title || '').join(' ');
      // 스타일번호 파싱 (타이틀에서)
      lensSku = parseSkuFromText(lensTitles, brand);
    } catch (e) { console.warn('Lens SKU skip:', e.message); }




    // 스타일번호: 렌즈에서 파싱된 경우만 보완
    if (!analysis.sku && lensSku) analysis.sku = lensSku;

    // DB 매칭
    let dbMatch = null;
    try {
      const dbRes = await sb('sku_items?select=*&limit=500');
      const dbData = await dbRes.json();
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
          if (aiSku && dbSku && aiSku === dbSku) { candidates.push({ item, score: 200 }); continue; }
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
          if (score >= 50) candidates.push({ item, score });
        }
        if (candidates.length > 0) {
          const maxScore = Math.max(...candidates.map(c => c.score));
          const topCandidates = candidates.filter(c => c.score === maxScore);
          const withNotes = topCandidates.find(c => c.item.notes && c.item.notes.trim());
          dbMatch = (withNotes || topCandidates[0]).item;
        }
      }
    } catch (e) { console.warn('DB skip:', e.message); }

    if (dbMatch) {
      dbMatch = {
        ...dbMatch,
        extra_images: Array.isArray(dbMatch.extra_images) ? dbMatch.extra_images : [],
        ref_image_url: dbMatch.ref_image_url || null,
      };
    }

    return res.status(200).json({
      success: true,
      imageUrl,
      analysis,
      dbMatch,
      visualMatches: visualMatches.slice(0, 12),
      lensSize,
      lensSizeName,
      lensSizeSources,
      lensSku,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
