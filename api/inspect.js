export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMime } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '이미지가 없습니다' });

  const IMGBB_KEY = process.env.IMGBB_KEY;
  const SERP_KEY = process.env.SERP_KEY;
  const CLAUDE_KEY = process.env.CLAUDE_KEY;

  try {
    // 1. imgbb 업로드
    const formData = new URLSearchParams();
    formData.append('key', IMGBB_KEY);
    formData.append('image', imageBase64);
    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: formData
    });
    const imgbbJson = await imgbbRes.json();
    if (!imgbbJson.success) throw new Error('imgbb 업로드 실패: ' + JSON.stringify(imgbbJson));
    const imageUrl = imgbbJson.data.url;

    // 2. SerpApi Google Lens
    let lensData = {};
    let visualMatches = [];
    try {
      const serpUrl = `https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SERP_KEY}`;
      const serpRes = await fetch(serpUrl);
      lensData = await serpRes.json();
      visualMatches = lensData.visual_matches || [];
    } catch (e) {
      console.warn('SerpApi 오류:', e.message);
    }

    // 3. Claude 분석
    const lensText = JSON.stringify({
      visual_matches: visualMatches.slice(0, 8).map(m => ({
        title: m.title,
        source: m.source,
        link: m.link,
        thumbnail: m.thumbnail,
        price: m.price
      })),
      related_content: (lensData.related_content || []).slice(0, 5).map(m => ({
        title: m.title,
        link: m.link
      }))
    });

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-20250514',
        max_tokens: 1024,
        system: `당신은 명품·패션 아이템 전문 감정사입니다.
Google Lens 검색 결과와 업로드된 사진을 종합하여 상품을 분석해주세요.
반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.

{
  "brand": "브랜드명 (영문)",
  "category": "카테고리 (가방/의류/시계/쥬얼리/벨트/모자/기타)",
  "model_name": "모델명",
  "sku": "SKU 또는 모델번호 (모르면 null)",
  "color": "색상",
  "size": "사이즈 (모르면 null)",
  "confidence": 85,
  "verdict": "pass",
  "verdict_reason": "판정 근거 한 줄",
  "price_range": "시세 범위 (예: 50만~80만원)",
  "origin": "원산지 (라벨에서 확인된 경우, 모르면 null)",
  "authenticity_notes": "정품 확인 포인트 또는 의심 포인트"
}

verdict 값: "pass"(합격) | "review"(검수자 확인 필요) | "fail"(불합격)
confidence: 0~100 정수`,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 }
            },
            {
              type: 'text',
              text: `Google Lens 검색 결과:\n${lensText}\n\n위 사진과 검색 결과를 바탕으로 JSON으로만 응답해주세요.`
            }
          ]
        }]
      })
    });

    const claudeJson = await claudeRes.json();
    const raw = claudeJson.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

    return res.status(200).json({
      success: true,
      imageUrl,
      analysis,
      visualMatches: visualMatches.slice(0, 10)
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
