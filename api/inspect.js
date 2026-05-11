export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageBase64, imageMime, extras = {} } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '이미지가 없습니다' });

  const IMGBB_KEY  = process.env.IMGBB_KEY;
  const SERP_KEY   = process.env.SERP_KEY;
  const CLAUDE_KEY = process.env.CLAUDE_KEY;

  try {
    // 1. imgbb 업로드
    const form = new URLSearchParams();
    form.append('key', IMGBB_KEY);
    form.append('image', imageBase64);
    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const imgbbJson = await imgbbRes.json();
    if (!imgbbJson.success) throw new Error('imgbb 업로드 실패');
    const imageUrl = imgbbJson.data.url;

    // 2. SerpApi Google Lens
    let visualMatches = [], knowledgeGraph = null;
    try {
      const serpUrl = `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SERP_KEY}`;
      const serpRes = await fetch(serpUrl);
      const lensData = await serpRes.json();
      visualMatches  = lensData.visual_matches  || [];
      knowledgeGraph = lensData.knowledge_graph || null;
    } catch (e) {
      console.warn('SerpApi 오류:', e.message);
    }

    // 3. Lens 결과에서 브랜드/모델/가격 추출
    const brandList = [
      'Louis Vuitton','Gucci','Chanel','Hermes','Prada','Burberry','Dior',
      'Balenciaga','Saint Laurent','Celine','Fendi','Bottega Veneta','Givenchy',
      'Valentino','Moncler','Canada Goose','The North Face','Nike','Adidas',
      'Supreme','Stone Island','Acne Studios','Maison Margiela','Off-White',
      'Loewe','Jacquemus','Ami Paris','Toteme','A.P.C.','Isabel Marant'
    ];
    let quickBrand = null, quickModel = null, quickPrice = null;
    if (knowledgeGraph) {
      quickBrand = knowledgeGraph.entity_type || null;
      quickModel = knowledgeGraph.title || null;
      quickPrice = knowledgeGraph.price ? knowledgeGraph.price.value : null;
    }
    const topMatches = visualMatches.slice(0, 8);
    const titleFreq = {};
    for (const m of topMatches) {
      const t = m.title || '';
      if (!quickBrand) {
        for (const b of brandList) {
          if (t.toLowerCase().includes(b.toLowerCase())) { quickBrand = b; break; }
        }
      }
      if (!quickPrice && m.price) {
        quickPrice = typeof m.price === 'object' ? (m.price.extracted_price || m.price.raw) : m.price;
      }
      const clean = t.replace(new RegExp(brandList.join('|'), 'gi'), '').trim();
      if (clean.length > 3) titleFreq[clean] = (titleFreq[clean] || 0) + 1;
    }
    if (!quickModel && Object.keys(titleFreq).length) {
      quickModel = Object.entries(titleFreq).sort((a, b) => b[1] - a[1])[0][0];
    }

    // 4. Claude 분석
    const imageContents = [
      { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: '위 이미지: 본품 전체샷' }
    ];
    for (const [key, b64] of Object.entries(extras)) {
      if (b64) {
        imageContents.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
        imageContents.push({ type: 'text', text: `위 이미지: ${key}` });
      }
    }
    const lensContext = JSON.stringify({
      knowledge_graph: knowledgeGraph,
      top_visual_matches: topMatches.map(m => ({
        title: m.title, source: m.source, link: m.link, price: m.price
      })),
      quick_extract: { brand: quickBrand, model: quickModel, price: quickPrice }
    });

    const claudeBody = {
      model: 'claude-3-5-sonnet-20240620',
      max_tokens: 1024,
      system: `당신은 명품·패션 아이템 전문 감정사입니다. Google Lens 검색 결과와 사진을 종합하여 상품 정보를 정확히 추출하세요.
규칙:
- Google Lens 결과에서 브랜드/모델명이 명확하면 그것을 우선 사용
- SKU/스타일번호는 라벨 사진이나 Lens 결과 제목에서 찾기
- 가격은 Google Shopping 결과 기준 참고가격
- verdict: 정품 의심 없으면 "pass", 불확실 "review", 가품 "fail"
- confidence: 0~100 정수
반드시 JSON만 응답:
{"brand":"브랜드명","category":"가방/의류/시계/쥬얼리/벨트/모자/신발/기타","model_name":"모델명","sku":null,"color":"색상","size":null,"confidence":87,"verdict":"pass","verdict_reason":"판정근거","price_range":"참고가격","origin":null,"authenticity_notes":"확인포인트"}`,
      messages: [{
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: `Google Lens 결과:\n${lensContext}\n\nJSON만 응답하세요.` }
        ]
      }]
    };

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(claudeBody)
    });

    const claudeText = await claudeRes.text();
    let claudeJson;
    try {
      claudeJson = JSON.parse(claudeText);
    } catch (e) {
      throw new Error('Claude 응답 파싱 실패: ' + claudeText.slice(0, 200));
    }
    if (claudeJson.error) throw new Error('Claude 오류: ' + claudeJson.error.message);

    const raw = claudeJson.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

    return res.status(200).json({
      success: true,
      imageUrl,
      analysis,
      visualMatches: visualMatches.slice(0, 12),
      knowledgeGraph
    });

  } catch (err) {
    console.error('inspect error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
