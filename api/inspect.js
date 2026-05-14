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
  // 인치 → cm 변환 (소수점 1자리 반올림)
  function inchToCm(val) {
    return Math.round(parseFloat(val) * 2.54 * 10) / 10;
  }

  // 숫자 파싱 + 인치면 cm 변환
  function normVal(numStr, isInch) {
    const n = parseFloat(numStr.replace(',', '.'));
    if (isNaN(n)) return null;
    return isInch ? inchToCm(n) : n;
  }

  function parseSizeFromText(text) {
    if (!text) return null;

    // 인치 여부 판단
    const hasInch = /\d\s*(?:in|inch|inches|"|″)/i.test(text);
    const hasCm   = /\d\s*cm/i.test(text);
    const hasMm   = /\d\s*mm/i.test(text);
    const isInch  = hasInch && !hasCm;

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
      // 소수점 정리: .0 이면 정수로
      const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
      return parts.map(fmt).join(' × ') + ' cm';
    }

    // 패턴2: "W25 H20 D6", "W:9.8in H:7.9in"
    const p2 = text.match(/[WwLl][:\s]?(\d{1,3}(?:[.,]\d{1,2})?)(\s*(?:cm|mm|in|inch|inches|"|″))?.{0,10}[HhDd][:\s]?(\d{1,3}(?:[.,]\d{1,2})?)(\s*(?:cm|mm|in|inch|inches|"|″))?/i);
    if (p2) {
      const u1 = (p2[2] || '').toLowerCase().trim();
      const u2 = (p2[4] || '').toLowerCase().trim();
      const inch1 = isInch || u1.startsWith('in') || u1 === '"';
      const inch2 = isInch || u2.startsWith('in') || u2 === '"';
      const w = normVal(p2[1], inch1);
      const h = normVal(p2[3], inch2);
      if (!w || !h) return null;
      const fmt = v => Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
      return fmt(w) + ' × ' + fmt(h) + ' cm';
    }

    return null;
  }

  function parseSizeNameFromText(text) {
    if (!text) return null;
    const m = text.match(/\b(nano|micro|baby|mini|petite|small|medium|large|xl|maxi|pm|mm|gm|tpm|bph|xs|xxs)\b/i);
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : null;
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
  if (action === 'fetch_size') {
    const { visualMatchLinks = [], brand, modelNameKo, modelNameEn } = req.body;
    const results = { sizes: [], sizeNames: [], sources: [] };

    // 링크 최대 8개 병렬 fetch (타임아웃 4초)
    const links = visualMatchLinks.slice(0, 8);
    await Promise.allSettled(links.map(async (link) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const r = await fetch(link, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
        });
        clearTimeout(timer);
        if (!r.ok) return;
        const html = await r.text();
        const texts = extractSizeTexts(html);
        for (const t of texts) {
          const sz = parseSizeFromText(t);
          const sn = parseSizeNameFromText(t);
          if (sz) { results.sizes.push(sz); results.sources.push(new URL(link).hostname); }
          if (sn) results.sizeNames.push(sn);
        }
      } catch (_) {}
    }));

    // 중복 기준 다수결
    const finalSize = majority(results.sizes) || null;
    const finalSizeName = majority(results.sizeNames) || null;

    return res.status(200).json({
      success: true,
      size: finalSize,
      size_label: finalSizeName,
      sources: [...new Set(results.sources)],
      raw_sizes: results.sizes,         // 디버그용
    });
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
      const r = await sb('sku_items', { method: 'POST', body: JSON.stringify(payload) });
      const d = await r.json();
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
      const r = await sb(`sku_items?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
      const d = await r.json();
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

      // 사이즈 파싱도 병행 (링크 fetch)
      const sizeResults = [];
      const nameResults = [];
      await Promise.allSettled(images.slice(0, 6).map(async (img) => {
        if (!img.link) return;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3500);
          const pr = await fetch(img.link, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
          });
          clearTimeout(timer);
          if (!pr.ok) return;
          const html = await pr.text();
          const clean = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ');
          const keyRe = /\b(size|dimension|measurement|치수|사이즈|width|height|depth)\b/gi;
          let m;
          while ((m = keyRe.exec(clean)) !== null) {
            const snippet = clean.slice(Math.max(0, m.index - 30), m.index + 150);
            const sz = parseSizeFromText(snippet);
            const sn = parseSizeNameFromText(snippet);
            if (sz) sizeResults.push(sz);
            if (sn) nameResults.push(sn);
          }
        } catch (_) {}
      }));

      const majority = (arr) => {
        if (!arr.length) return null;
        const freq = {};
        for (const v of arr) freq[v] = (freq[v] || 0) + 1;
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
      };

      return res.status(200).json({
        success: true,
        visualMatches: images,
        lensSize:      majority(sizeResults) || null,
        lensSizeName:  majority(nameResults) || null,
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
{"brand":"영문브랜드명","category":"가방/의류/시계/쥬얼리/벨트/모자/신발/기타","model_name":"영문모델명","model_name_ko":"한글모델명(없으면null)","sku":null,"color":"색상","size":null,"confidence":85,"verdict":"pass","verdict_reason":"판정근거한줄","price_range":"참고가격","origin":null,"authenticity_notes":"확인포인트"}
verdict: pass/review/fail, confidence: 0-100 정수`,
          messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: 'JSON만 응답' }] }]
        })
      }).then(r => r.json())
    ]);

    if (claudeRes.error) throw new Error('Claude 오류: ' + claudeRes.error.message);
    const raw = claudeRes.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

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

    // Google Lens
    let visualMatches = [];
    try {
      const s = await fetch(`https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SERP_KEY}`);
      const j = await s.json();
      visualMatches = j.visual_matches || [];
    } catch (e) { console.warn('Lens skip'); }

    // ── 렌즈 결과에서 사이즈 자동 파싱 (백그라운드) ──────────────────
    let lensSize = null;
    let lensSizeName = null;
    let lensSizeSources = [];
    try {
      const links = visualMatches
        .map(m => m.link)
        .filter(Boolean)
        .slice(0, 8);

      const sizeResults = [];
      const nameResults = [];

      await Promise.allSettled(links.map(async (link) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4000);
          const r = await fetch(link, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
          });
          clearTimeout(timer);
          if (!r.ok) return;
          const html = await r.text();

          // HTML → 텍스트 정제
          const clean = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ');

          // 사이즈 키워드 주변 텍스트 추출
          const sizeKeyRe = /\b(size|dimension|measurement|치수|사이즈|크기|실측|가로|세로|높이|width|height|depth|length|specifications?)\b/gi;
          let m2;
          while ((m2 = sizeKeyRe.exec(clean)) !== null) {
            const snippet = clean.slice(Math.max(0, m2.index - 30), m2.index + 150);
            const sz = parseSizeFromText(snippet);
            const sn = parseSizeNameFromText(snippet);
            if (sz) { sizeResults.push(sz); lensSizeSources.push(new URL(link).hostname); }
            if (sn) nameResults.push(sn);
          }
          // 숫자×숫자 패턴 직접 검색
          const directRe = /\d{1,3}\s*[x×*]\s*\d{1,3}/g;
          let dm;
          while ((dm = directRe.exec(clean)) !== null) {
            const snippet = clean.slice(Math.max(0, dm.index - 20), dm.index + 80);
            const sz = parseSizeFromText(snippet);
            if (sz) { sizeResults.push(sz); lensSizeSources.push(new URL(link).hostname); }
          }
        } catch (_) {}
      }));

      // 다수결: 2개 이상 일치 우선, 없으면 첫 번째
      if (sizeResults.length > 0) {
        const freq = {};
        for (const v of sizeResults) freq[v] = (freq[v] || 0) + 1;
        const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
        lensSize = sorted[0][0];
      }
      if (nameResults.length > 0) {
        const freq = {};
        for (const v of nameResults) freq[v] = (freq[v] || 0) + 1;
        lensSizeName = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
      }
      lensSizeSources = [...new Set(lensSizeSources)];
    } catch (e) { console.warn('Lens size parse skip:', e.message); }

    // analysis에 렌즈 사이즈 병합 (AI가 못 찾았을 때만)
    if (!analysis.size && lensSize) analysis.size = lensSize;
    if (!analysis.size_label && lensSizeName) analysis.size_label = lensSizeName;

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
      // 렌즈 파싱 결과 별도 반환 (프론트에서 출처 배지 표시용)
      lensSize,
      lensSizeName,
      lensSizeSources,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
