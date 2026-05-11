export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, imageMime, extras = {} } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '이미지가 없습니다' });

  const IMGBB_KEY  = process.env.IMGBB_KEY;
  const SERP_KEY   = process.env.SERP_KEY;
  const CLAUDE_KEY = process.env.CLAUDE_KEY;

  try {
    // 1. imgbb 업로드 + SerpApi 동시 실행
    const form = new URLSearchParams();
    form.append('key', IMGBB_KEY);
    form.append('image', imageBase64);

    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const imgbbJson = await imgbbRes.json();
    if (!imgbbJson.success) throw new Error('imgbb 업로드 실패');
    const imageUrl = imgbbJson.data.url;

    // 2. SerpApi + Claude 동시 실행
    const serpPromise = fetch(`https://serpapi.com/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${SERP_KEY}`)
      .then(r => r.json())
      .catch(() => ({}));

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

    const claudePromise = fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `명품·패션 감정사. 사진 보고 JSON만 응답. 다른 텍스트 금지.
{"brand":"영문브랜드명","category":"가방/의류/시계/쥬얼리/벨트/모자/신발/기타","model_name":"모델명","sku":null,"color":"색상","size":null,"confidence":85,"verdict":"pass","verdict_reason":"판정근거","price_range":"참고가격","origin":null,"authenticity_notes":"확인포인트"}
verdict: pass/review/fail, confidence: 0-100 정수`,
        messages: [{ role: 'user', content: [...imageContents, { type: 'text', text: 'JSON만 응답하세요.' }] }]
      })
    }).then(r => r.json());

    // 3. 둘 다 기다림
    const [lensData, claudeJson] = await Promise.all([serpPromise, claudePromise]);

    if (claudeJson.error) throw new Error('Claude 오류: ' + claudeJson.error.message);

    const raw = claudeJson.content?.[0]?.text?.trim() || '{}';
    const analysis = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const visualMatches = lensData.visual_matches || [];

    return res.status(200).json({
      success: true,
      imageUrl,
      analysis,
      visualMatches: visualMatches.slice(0, 12)
    });

  } catch (err) {
    console.error('inspect error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
