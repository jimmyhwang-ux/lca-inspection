async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMime, extras = {}, action, skuData } = req.body;

  const SERP_KEY     = process.env.SERP_KEY;
  const CLAUDE_KEY   = process.env.CLAUDE_KEY;
  const GEMINI_KEY   = process.env.GEMINI_API_KEY;
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

  const uploadImage = async (b64) => {
    const buffer = Buffer.from(b64, 'base64');
    const fileName = `sku-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sku_image/${fileName}`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'image/jpeg',
          'x-upsert': 'true',
        },
        body: buffer,
      }
    );
    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error('Storage 업로드 실패: ' + err);
    }
    return `${SUPABASE_URL}/storage/v1/object/public/sku_image/${fileName}`;
  };

  if (action === 'check_password') {
    const ACCESS_PW = process.env.ACCESS_PASSWORD || 'lca2024';
    const { password } = req.body;
    return res.status(200).json({ success: password === ACCESS_PW });
  }

  if (action === 'check_gemini_key') {
    return res.status(200).json({ hasKey: !!GEMINI_KEY });
  }

  if (action === 'gemini_search') {
    try {
      if (!GEMINI_KEY) {
        return res.status(200).json({ success: false, error: 'Gemini API 키가 서버에 설정되지 않았어요' });
      }
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ success: false, error: 'prompt 없음' });

      const isOAuth = GEMINI_KEY.startsWith('AQ.') || GEMINI_KEY.startsWith('ya29.');

      let geminiRes;
      if (isOAuth) {
        geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_KEY}` },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 1000 }
            })
          }
        );
      } else {
        geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 1000 }
            })
          }
        );
      }

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        if (geminiRes.status === 401 || geminiRes.status === 403) {
          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001', max_tokens: 500,
              messages: [{ role: 'user', content: prompt }]
            })
          });
          const cj = await claudeRes.json();
          const text = cj.content?.[0]?.text || '';
          return res.status(200).json({ success: true, text, source: 'claude' });
        }
        return res.status(200).json({ success: false, error: 'Gemini 오류: ' + errText.slice(0, 200) });
      }

      const geminiData = await geminiRes.json();
      const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ success: true, text });
    } catch (e) {
      return res.status(200).json({ success: false, error: e.message });
    }
  }

  // ✅ serp_text_search: 키워드로 SerpAPI 검색 후 Claude가 텍스트로 요약
  if (action === 'serp_text_search') {
    try {
      const { keyword } = req.body;
      if (!keyword) return res.status(400).json({ success: false, error: 'keyword 없음' });

      // SerpAPI 검색
      let searchContext = '';
      try {
        const encoded = encodeURIComponent(keyword);
        const serpRes = await fetch(
          `https://serpapi.com/search.json?q=${encoded}&api_key=${SERP_KEY}&num=8&hl=ko`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (serpRes.ok) {
          const serpData = await serpRes.json();
          const results = serpData.organic_results || [];
          const snippets = results.slice(0, 5).map(r => `[${r.title}] ${r.snippet||''}`).filter(Boolean);
          if (snippets.length > 0) searchContext = snippets.join('\n');
        }
      } catch (e) {
        console.warn('[serp_text_search] SerpAPI 오류:', e.message);
      }

      const prompt = `아래 검색 결과를 바탕으로 제품 공식 스펙을 간결하게 정리해줘.
없는 항목은 "없음"으로 표시. 불필요한 설명 없이 아래 항목만:
• 실측 사이즈 (가로/세로/두께 또는 체인길이, 단위 포함)
• 소재
• 스타일번호
• 공식 사이트 URL
• 특이사항 (있을 때만)

검색어: ${keyword}

${searchContext ? '검색 결과:\n' + searchContext : '(검색 결과 없음 — 학습 데이터 기반으로 답변)'}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const claudeData = await claudeRes.json();
      if (claudeData.error) throw new Error('Claude 오류: ' + claudeData.error.message);
      const text = claudeData.content?.[0]?.text?.trim() || '';
      return res.status(200).json({ success: true, text, source: searchContext ? 'serp+claude' : 'claude' });
    } catch (e) {
      return res.status(200).json({ success: false, error: e.message });
    }
  }

  if (action === 'serp_autofill') {
    try {
      const { brand, modelKo, modelEn, cat } = req.body;
      const modelName = modelKo || modelEn || '';
      if (!modelName) return res.status(400).json({ success: false, error: '모델명 없음' });

      // 1단계: SerpAPI로 웹 검색
      let searchContext = '';
      try {
        const queries = [
          `${brand} ${modelName} specifications size dimensions`,
          `${brand} ${modelName} 사이즈 스펙 공식`,
        ];
        const serpResults = [];
        for (const q of queries) {
          const encoded = encodeURIComponent(q);
          const serpRes = await fetch(
            `https://serpapi.com/search.json?q=${encoded}&api_key=${SERP_KEY}&num=5&hl=ko`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (!serpRes.ok) continue;
          const serpData = await serpRes.json();
          const results = serpData.organic_results || [];
          for (const r of results.slice(0, 3)) {
            if (r.title && r.snippet) {
              serpResults.push(`[${r.title}] ${r.snippet}`);
            }
          }
        }
        if (serpResults.length > 0) {
          searchContext = '\n\n[웹 검색 결과]\n' + serpResults.join('\n');
        }
      } catch (e) {
        console.warn('[serp_autofill] SerpAPI 오류:', e.message);
      }

      // 2단계: Claude로 스펙 추출
      const sizeRules = {
        '가방': 'size_w=가로(cm), size_h=세로(cm), size_d=너비(cm), size_unit=cm',
        '지갑': 'size_w=가로(cm), size_h=세로(cm), size_d=너비(cm), size_unit=cm',
        '주얼리': 'size_d=체인길이(cm) 필수, size_w=펜던트가로(mm), size_unit=mm (반지: size_label=호수)',
        '시계': 'size_w=케이스직경(mm), size_h=두께(mm), size_unit=mm',
        '의류': 'size_w=사이즈표기(S,M,L,95 등)',
        '신발': 'size_w=사이즈표기(270 등)',
        '벨트': 'size_w=폭(cm), size_unit=cm',
      };
      const sizeRule = sizeRules[cat] || 'size_w=사이즈';

      const prompt = `당신은 명품 감정 전문가입니다. 아래 상품의 공식 스펙을 JSON으로만 답하세요.
절대로 JSON 외 다른 텍스트를 출력하지 마세요. 마크다운 금지.

브랜드: ${brand}
모델명: ${modelName}
카테고리: ${cat}

[사이즈 입력 규칙]
${sizeRule}
값을 모를 경우 빈문자열('')로 입력. 절대로 0 입력 금지.
${searchContext}

출력 형식 (이 JSON 구조를 그대로 사용):
{
"style_number": "스타일번호",
"model_ko": "한글 모델명",
"category": "카테고리 (가방/지갑/주얼리/시계/의류/신발/벨트 중 하나)",
"size_w": "숫자만",
"size_h": "숫자만",
"size_d": "숫자만",
"size_unit": "cm 또는 mm",
"size_label": "사이즈 명칭 (예: OS, Small, MM)",
"material": "소재",
"made_in": "제조국",
"official_url": "공식 제품 페이지 URL (없으면 빈 문자열)",
"image_url": "공식 대표 이미지 URL (없으면 빈 문자열)",
"notes": "검수 참고 정보"
}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const claudeData = await claudeRes.json();
      if (claudeData.error) throw new Error('Claude 오류: ' + claudeData.error.message);

      const rawText = claudeData.content?.[0]?.text?.trim() || '';
      let parsed = null;
      try {
        const jm = rawText.match(/```json[\s\S]*?({[\s\S]*?})[\s\S]*?```/) || rawText.match(/({[\s\S]*})/);
        const jStr = (jm && jm[1]) || rawText;
        const jStrFixed = jStr.trim().endsWith('}') ? jStr : jStr.replace(/,\s*$/, '') + '}';
        parsed = JSON.parse(jStrFixed);
      } catch (e) {
        const partials = {};
        for (const m of rawText.matchAll(/"([\w_]+)"\s*:\s*"([^"]*?)"/g)) partials[m[1]] = m[2];
        for (const m of rawText.matchAll(/"([\w_]+)"\s*:\s*([\d.]+)/g)) partials[m[1]] = m[2];
        if (Object.keys(partials).length > 0) parsed = partials;
        else throw new Error('JSON 파싱 실패');
      }

      return res.status(200).json({
        success: true,
        data: parsed,
        source: searchContext ? 'serp+claude' : 'claude'
      });

    } catch (e) {
      return res.status(200).json({ success: false, error: e.message });
    }
  }

  if (action === 'save_sku') {
    try {
      let extra_images = skuData.extra_images || [];
      if (skuData.newImageBase64) {
        const url = await uploadImage(skuData.newImageBase64);
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
        const url = await uploadImage(newImageBase64);
        fields.extra_images = [...(fields.extra_images || []), url];
        if (!fields.ref_image_url) fields.ref_image_url = url;
      }
      if (Array.isArray(fields.extra_images) && fields.extra_images.length === 0) {
        fields.ref_image_url = null;
      }
      if (!fields.ref_image_url && fields.extra_images?.length > 0) {
        fields.ref_image_url = fields.extra_images[0];
      }
      if (fields.accessories && !Array.isArray(fields.accessories)) fields.accessories = [];
      fields.updated_at = new Date().toISOString();
      fields.verified = true;
      fields.verified_at = new Date().toISOString();
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
      const url = await uploadImage(req.body.imageBase64);
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
          model: 'claude-haiku-4-5-20251001', max_tokens: 60,
          messages: [{ role: 'user', content: `Translate this Korean luxury product model name to English. Output the English translation only, one line, no explanation.\nKorean: ${modelNameKo}` }]
        })
      });
      const j = await r.json();
      return res.status(200).json({ model_name_en: (j.content?.[0]?.text||'').trim().split('\n')[0] });
    } catch (e) { return res.status(500).json({ model_name_en: '' }); }
  }

  if (action === 'search_image') {
    try {
      const { query, serpApiKey } = req.body;
      if (!query) return res.status(400).json({ success: false, error: 'query 없음' });
      if (serpApiKey) {
        const encoded = encodeURIComponent(query);
        const serpUrl = `https://serpapi.com/search.json?q=${encoded}&tbm=isch&api_key=${serpApiKey}&num=5&safe=active`;
        try {
          const serpR = await fetch(serpUrl);
          if (serpR.ok) {
            const serpD = await serpR.json();
            const imgs = serpD.images_results || [];
            for (const img of imgs) {
              const imgUrl = img.original || img.thumbnail;
              if (!imgUrl) continue;
              try {
                const ir = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.google.com' } });
                if (!ir.ok) continue;
                const buf = Buffer.from(await ir.arrayBuffer());
                if (buf.length < 2000) continue;
                const b64 = buf.toString('base64');
                const ct = ir.headers.get('content-type') || 'image/jpeg';
                return res.status(200).json({ success: true, base64: b64, mime: ct, sourceUrl: imgUrl });
              } catch (e) { continue; }
            }
          }
        } catch (e) { console.log('[search_image] SerpAPI 오류:', e.message); }
      }
      const encoded = encodeURIComponent(query);
      const sources = [
        `https://www.farfetch.com/kr/shopping/women/search/?q=${encoded}&view=90&sort=3`,
        `https://www.farfetch.com/kr/shopping/men/search/?q=${encoded}&view=90&sort=3`,
        `https://www.mytheresa.com/int_en/search.html?q=${encoded}`,
      ];
      for (const url of sources) {
        try {
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
          if (!r.ok) continue;
          const html = await r.text();
          const patterns = [
            /cdn-images\.farfetch-contents\.com\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/gi,
            /media\.mytheresa\.com\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/gi,
          ];
          for (const pat of patterns) {
            const matches = html.match(pat);
            if (matches && matches.length > 0) {
              const imgUrl = 'https://' + matches[0];
              const imgR = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': url } });
              if (!imgR.ok) continue;
              const buf = Buffer.from(await imgR.arrayBuffer());
              if (buf.length < 1000) continue;
              const b64 = buf.toString('base64');
              const ct = imgR.headers.get('content-type') || 'image/jpeg';
              return res.status(200).json({ success: true, base64: b64, mime: ct, sourceUrl: imgUrl });
            }
          }
        } catch (e) { continue; }
      }
      return res.status(200).json({ success: false, error: '이미지를 찾지 못했어요' });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  if (action === 'serp_text_search') {
    try {
      const { keyword } = req.body;
      if (!keyword) return res.status(400).json({ success: false, error: 'keyword 없음' });
      let searchContext = '';
      try {
        const sr = await fetch('https://serpapi.com/search.json?q=' + encodeURIComponent(keyword) + '&api_key=' + SERP_KEY + '&num=8&hl=ko', { signal: AbortSignal.timeout(10000) });
        if (sr.ok) {
          const sd = await sr.json();
          const snippets = (sd.organic_results||[]).slice(0,5).map(r => '[' + r.title + '] ' + (r.snippet||'')).filter(Boolean);
          if (snippets.length) searchContext = snippets.join('\n');
        }
      } catch(e) { console.warn('[serp_text_search]', e.message); }
      const prompt = '당신은 명품 감정 전문가입니다. 아래 제품의 공식 스펙을 알고 있는 대로 답하세요.\n'
        + '검색 결과가 없어도 학습 데이터 기반으로 최대한 답하세요. 모른다고 하지 마세요.\n'
        + '아래 항목만 간결하게:\n• 실측 사이즈 (가로x세로x너비, 단위 포함)\n• 소재\n• 스타일번호\n• 공식 사이트 URL\n• 특이사항\n\n'
        + '제품: ' + keyword + '\n\n'
        + (searchContext ? '[참고 검색 결과]\n' + searchContext : '');
      const cr = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }) });
      const cd = await cr.json();
      if (cd.error) throw new Error(cd.error.message);
      return res.status(200).json({ success: true, text: (cd.content||[])[0]?.text?.trim()||'', source: searchContext ? 'serp+claude' : 'claude' });
    } catch(e) { return res.status(200).json({ success: false, error: e.message }); }
  }

  if (action === 'serp_autofill') {
    try {
      const { brand, modelKo, modelEn, cat } = req.body;
      const modelName = modelKo || modelEn || '';
      if (!modelName) return res.status(400).json({ success: false, error: '모델명 없음' });
      let searchContext = '';
      try {
        const qs = [brand + ' ' + modelName + ' specifications size', brand + ' ' + modelName + ' 사이즈 스펙'];
        const results = [];
        for (const q of qs) {
          const sr = await fetch('https://serpapi.com/search.json?q=' + encodeURIComponent(q) + '&api_key=' + SERP_KEY + '&num=5', { signal: AbortSignal.timeout(10000) });
          if (!sr.ok) continue;
          const sd = await sr.json();
          for (const r of (sd.organic_results||[]).slice(0,3)) { if (r.title && r.snippet) results.push('[' + r.title + '] ' + r.snippet); }
        }
        if (results.length) searchContext = results.join('\n');
      } catch(e) { console.warn('[serp_autofill]', e.message); }
      const sizeRules = { '가방': 'size_w=가로(cm), size_h=세로(cm), size_d=너비(cm)', '지갑': 'size_w=가로(cm), size_h=세로(cm)', '주얼리': 'size_d=체인길이(cm), size_w=펜던트가로(mm)', '시계': 'size_w=케이스직경(mm), size_h=두께(mm)', '의류': 'size_w=사이즈표기', '신발': 'size_w=사이즈표기', '벨트': 'size_w=폭(cm)' };
      const prompt = '명품 감정 전문가. 공식 스펙 JSON만 답하세요. 마크다운 금지.\n브랜드: ' + brand + '\n모델명: ' + modelName + '\n카테고리: ' + cat + '\n사이즈규칙: ' + (sizeRules[cat]||'size_w=사이즈') + '\n' + (searchContext ? '[검색결과]\n' + searchContext + '\n' : '') + '\n출력: {"style_number":"","model_ko":"","category":"","size_w":"","size_h":"","size_d":"","size_unit":"","size_label":"","material":"","made_in":"","official_url":"","image_url":"","notes":""}';
      const cr = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }) });
      const cd = await cr.json();
      if (cd.error) throw new Error(cd.error.message);
      const rawText = (cd.content||[])[0]?.text?.trim()||'';
      let parsed = null;
      try { parsed = JSON.parse(rawText.match(/({[^]*})/)?.[1] || rawText); }
      catch(e) { const p = {}; for (const m of rawText.matchAll(/"(\w+)"\s*:\s*"([^"]*)"/g)) p[m[1]] = m[2]; if (Object.keys(p).length) parsed = p; else throw new Error('JSON 파싱 실패'); }
      return res.status(200).json({ success: true, data: parsed, source: searchContext ? 'serp+claude' : 'claude' });
    } catch(e) { return res.status(200).json({ success: false, error: e.message }); }
  }

  if (action === 'gemini_proxy') {
    try {
      const { apiKey, model, body } = req.body;
      if (!body) return res.status(400).json({ success: false, error: '파라미터 없음' });

      // AQ. 키(OAuth)면 Claude로 우회
      const isOAuth = !apiKey || apiKey.startsWith('AQ.') || apiKey.startsWith('ya29.');
      if (isOAuth) {
        const parts = (body.contents||[]).flatMap(c => c.parts||[]);
        const prompt = parts.map(p => p.text||'').join('\n');
        const hasSearch = (body.tools||[]).some(t => t.google_search !== undefined);
        const serpContext = hasSearch && SERP_KEY ? await (async () => {
          try {
            const sr = await fetch('https://serpapi.com/search.json?q=' + encodeURIComponent(prompt.slice(0,200)) + '&api_key=' + SERP_KEY + '&num=5', { signal: AbortSignal.timeout(8000) });
            if (!sr.ok) return '';
            const sd = await sr.json();
            return (sd.organic_results||[]).slice(0,4).map(r => '[' + r.title + '] ' + (r.snippet||'')).join('\n');
          } catch(e) { return ''; }
        })() : '';
        const finalPrompt = prompt + (serpContext ? '\n\n[검색결과]\n' + serpContext : '');
        const cr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: finalPrompt }] })
        });
        const cd = await cr.json();
        const text = (cd.content||[])[0]?.text || '';
        return res.status(200).json({ success: true, data: { candidates: [{ content: { parts: [{ text }] } }] } });
      }

      // 정상 AIzaSy 키면 Gemini 직접 호출
      const targetModel = model || 'gemini-2.5-flash';
      const geminiRes = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + targetModel + ':generateContent',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) }
      );
      const data = await geminiRes.json();
      return res.status(200).json({ success: true, data });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  if (action === 'proxy_image') {
    try {
      const { imageUrl } = req.body;
      if (!imageUrl) return res.status(400).json({ success: false, error: 'URL 없음' });
      const r = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/*,*/*',
          'Referer': new URL(imageUrl).origin
        }
      });
      if (!r.ok) return res.status(400).json({ success: false, error: 'fetch 실패: '+r.status });
      const arrayBuf = await r.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const b64 = buf.toString('base64');
      const ct = r.headers.get('content-type') || 'image/jpeg';
      return res.status(200).json({ success: true, base64: b64, mime: ct });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }

  // ── 메인 검수 ──────────────────────────────────────────────
  if (!imageBase64) return res.status(400).json({ error: '이미지 없음' });

  try {
    const imageContents = [
      { type: 'image', source: { type: 'base64', media_type: imageMime||'image/jpeg', data: imageBase64 } },
      { type: 'text', text: '본품 전체샷' }
    ];
    let extraCount = 0;
    for (const [key, b64] of Object.entries(extras)) {
      if (b64 && extraCount < 3) {
        imageContents.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
        imageContents.push({ type: 'text', text: key });
        extraCount++;
      }
    }

    const claudePromise = fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 800,
        system: `명품·패션 감정사. 사진 보고 JSON만 응답. 다른 텍스트 절대 금지.
{"brand":"영문브랜드명","category":"가방/의류/시계/쥬얼리/벨트/모자/신발/기타","model_name":"영문모델명","model_name_ko":"한글모델명(없으면null)","sku":null,"color":"색상","size":null,"confidence":85,"verdict":"pass","verdict_reason":"판정근거한줄","price_range":"참고가격","origin":null,"authenticity_notes":"확인포인트"}
verdict: pass/review/fail, confidence: 0-100 정수`,
        messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: 'JSON만 응답' }] }]
      })
    }).then(r => r.json());

    const imageUrlPromise = uploadImage(imageBase64).catch(e => {
      console.warn('[Storage 업로드 실패]', e.message); return '';
    });

    const dbPromise = sb('sku_items?select=*&order=created_at.desc&limit=10000')
      .then(async r => {
        const data = await r.json();
        return Array.isArray(data) ? data : [];
      })
      .catch(e => { console.error('[DB fetch error]', e.message); return []; });

    const [claudeRes, imageUrl, dbData] = await Promise.all([claudePromise, imageUrlPromise, dbPromise]);

    if (claudeRes.error) throw new Error('Claude 오류: ' + (claudeRes.error.message||''));
    const raw = claudeRes.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const BRAND_MAP = {
      'gucci':'구찌','louisvuitton':'루이비통','hermes':'에르메스','chanel':'샤넬',
      'dior':'디올','prada':'프라다','balenciaga':'발렌시아가','saintlaurent':'생로랑',
      'ysl':'생로랑','bottegaveneta':'보테가베네타','celine':'셀린느','loewe':'로에베',
      'fendi':'펜디','valentino':'발렌티노','givenchy':'지방시','burberry':'버버리',
      'moncler':'몽클레어','thombrowne':'톰브라운','miumiu':'미우미우',
      'maisonmargiela':'메종마르지엘라','goyard':'고야드','delvaux':'델보',
      'cartier':'까르띠에','rolex':'롤렉스','omega':'오메가','tagheuer':'태그호이어',
      'patekphilippe':'파텍필립','audemarspiguet':'오데마피게','iwc':'아이더블유씨',
      'breitling':'브라이틀링','bulgari':'불가리','bvlgari':'불가리','tiffany':'티파니',
      'vancleefarpe':'반클리프','chaumet':'쇼메','fred':'프레드',
      '반클리프앤아펠':'반클리프아펠','반클리프 앤 아펠':'반클리프아펠',
      'van cleef & arpels':'반클리프아펠','van cleef arpels':'반클리프아펠',
      'ferragamo':'페라가모','mulberry':'멀버리','coach':'코치',
      'hamilton':'해밀턴','tissot':'티쏘','longines':'론진',
      'vancleefarpels':'반클리프아펠',
    };

    function normBrand(b) { return b.toLowerCase().replace(/[\s\-&·]/g, ''); }
    function brandMatches(aiBrand, dbBrand) {
      if (!aiBrand || !dbBrand) return false;
      const ai = normBrand(aiBrand), db = normBrand(dbBrand);
      if (db.includes(ai) || ai.includes(db)) return true;
      const aiEn = BRAND_MAP[ai] ? normBrand(BRAND_MAP[ai]) : ai;
      const dbEn = BRAND_MAP[db] ? normBrand(BRAND_MAP[db]) : db;
      if (aiEn && dbEn && (aiEn.includes(dbEn) || dbEn.includes(aiEn))) return true;
      const aiFromDb = Object.entries(BRAND_MAP).find(([k,v]) => normBrand(v) === db)?.[0];
      if (aiFromDb && (ai.includes(aiFromDb) || aiFromDb.includes(ai))) return true;
      return false;
    }

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
          if (!aiBrand || !dbBrand) continue;
          const isUnknownBrand = ['unknown','기타','알수없음','unidentified'].includes(aiBrand.toLowerCase());
          if (!isUnknownBrand && !brandMatches(aiBrand, dbBrand)) continue;
          if (aiSku && dbSku && aiSku === dbSku) { candidates.push({ item, score: 200 }); continue; }
          let score = 0;
          if (aiModel && dbModel) {
            if (aiModel === dbModel) score = 100;
            else if (dbModel.includes(aiModel) || aiModel.includes(dbModel)) score = 70;
            else {
              const w1 = aiModel.split(' ').filter(w => w.length >= 2);
              const w2 = dbModel.split(' ').filter(w => w.length >= 2);
              if (w1.length >= 1) {
                const hits = w1.filter(w => w2.includes(w)).length;
                const ratio = hits / w1.length;
                if (w1.length === 1 && hits === 1) score = Math.max(score, 60);
                else if (ratio >= 0.6) score = Math.round(ratio * 60);
              }
            }
          }
          if (aiModelKo && dbModelKo) {
            if (aiModelKo === dbModelKo) score = Math.max(score, 95);
            else if (dbModelKo.includes(aiModelKo) || aiModelKo.includes(dbModelKo)) score = Math.max(score, 70);
            else {
              const koToks = aiModelKo.split(/\s+/).filter(w => w.length >= 2);
              if (koToks.length > 0) {
                const hits = koToks.filter(t => dbModelKo.includes(t)).length;
                if (hits > 0) score = Math.max(score, Math.round(60 + (hits / koToks.length) * 30));
              }
            }
          }
          if (score >= 60) candidates.push({ item, score });
        }
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.score - a.score);
          const maxScore = candidates[0].score;
          const topCandidates = candidates.filter(c => c.score >= maxScore - 10);
          topCandidates.sort((a, b) => (b.item.notes ? 1 : 0) - (a.item.notes ? 1 : 0));
          dbMatches = topCandidates.slice(0, 5).map(c => c.item);
        }
      }
    } catch (e) { console.warn('DB skip:', e.message); }

    let visualMatches = [];
    try {
      if (imageUrl) {
        const lensController = new AbortController();
        const lensTimeout = setTimeout(() => lensController.abort(), 15000);
        const s = await fetch(
          `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SERP_KEY}`,
          { signal: lensController.signal }
        );
        clearTimeout(lensTimeout);
        const j = await s.json();
        visualMatches = j.visual_matches || [];
      }
    } catch (e) { console.warn('Lens skip:', e.message); }

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

module.exports = handler;
