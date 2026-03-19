/**
 * 드라마스크립트 AI — Cloudflare Worker 프록시
 * GenSpark LLM API를 중계해 프론트에서 API 키 없이 AI 생성 가능
 */

const CORS_HEADERS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || 'https://happymarckim-ux.github.io';
  // 개발 환경(localhost, sandbox) 허용
  if (
    origin === allowed ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.includes('.sandbox.') ||
    origin.includes('.novita.ai') ||
    origin.includes('.e2b.dev')
  ) return origin;
  return allowed; // fallback
}

export default {
  async fetch(request, env) {
    const origin = isAllowedOrigin(request, env);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS(origin) });
    }

    const url = new URL(request.url);

    // ── /generate  : 드라마 기획 + 결과 생성 ──
    if (url.pathname === '/generate' && request.method === 'POST') {
      return handleGenerate(request, env, origin);
    }

    // ── /health ──
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS(origin) },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

/* ────────────────────────────────────────────
   메인 생성 핸들러
──────────────────────────────────────────── */
async function handleGenerate(request, env, origin) {
  let body;
  try { body = await request.json(); } catch {
    return errorRes('Invalid JSON', 400, origin);
  }

  const { platform, episodes, runtime, genre, title, logline, extra, chars } = body;

  if (!title || !logline) {
    return errorRes('title and logline are required', 400, origin);
  }

  const apiKey = env.GENSPARK_TOKEN;
  const baseUrl = env.LLM_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1';

  if (!apiKey) return errorRes('Server API key not configured', 500, origin);

  // ── 프롬프트 구성 ──
  const charDesc = (chars || []).map(c =>
    `- ${c.label}: ${c.name}(${c.age}) / ${c.job} / ${c.personality}`
  ).join('\n');

  const systemPrompt = `당신은 15년 경력의 K-드라마 전문 작가입니다. 
주어진 설정을 바탕으로 완성도 높은 드라마 기획서를 한국어로 작성합니다.
반드시 요청한 JSON 형식만 반환하세요. JSON 외 다른 텍스트는 절대 포함하지 마세요.`;

  const userPrompt = `다음 설정으로 K-드라마 기획서를 작성해 주세요.

[설정]
- 플랫폼: ${platform || 'OTT 오리지널'}
- 총 회차: ${episodes || 8}부작
- 회당 분량: ${runtime || 60}분
- 장르/톤: ${genre || '로맨틱 코미디'}
- 제목(가제): ${title}
- 로그라인: ${logline}
- 추가 설정: ${extra || '없음'}
- 인물:
${charDesc || '없음'}

아래 JSON 스키마에 맞춰 정확히 반환하세요:
{
  "logline": "한 줄 로그라인(최대 80자)",
  "synopsis": "전체 줄거리(200~300자)",
  "conflicts": [
    {"label":"갈등 이름","color":"red|gold|teal|ink","desc":"설명(50자)"},
    {"label":"갈등 이름","color":"red|gold|teal|ink","desc":"설명(50자)"},
    {"label":"갈등 이름","color":"red|gold|teal|ink","desc":"설명(50자)"},
    {"label":"갈등 이름","color":"red|gold|teal|ink","desc":"설명(50자)"}
  ],
  "stats": {
    "budget": "총 제작비(예: 127.5억)",
    "scenes": "총 씬 수(예: 200씬)",
    "ppl": "PPL 예상 수익(예: 6.5억)",
    "budgetRaw": 1275000,
    "pplRaw": 65000
  },
  "episodes": [
    {
      "num": 1,
      "title": "회차 제목",
      "story": "줄거리 (100~150자)",
      "ending": "엔딩 장면 한 줄"
    }
  ],
  "script": [
    {
      "heading": "S# 1. 장소 (시간대)",
      "lines": [
        {"type":"action","text":"지문"},
        {"type":"dialog","char":"캐릭터이름","paren":"지시어","line":"대사"},
        {"type":"direction","text":"방향 지시"}
      ]
    }
  ]
}

episodes 배열은 총 ${episodes || 8}개 회차 전부 포함.
script는 1화 첫 3씬만 작성.
JSON만 반환, 마크다운 코드블록 없이.`;

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 4000,
        temperature: 0.85,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('LLM error:', resp.status, errText);
      return errorRes(`LLM API error: ${resp.status}`, 502, origin);
    }

    const data = await resp.json();
    const rawContent = data.choices?.[0]?.message?.content || '';

    // JSON 파싱 시도 (마크다운 코드블록 제거 후)
    const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/,'').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse error:', e, 'raw:', cleaned.slice(0, 200));
      return errorRes('AI 응답 파싱 실패. 다시 시도해 주세요.', 500, origin);
    }

    return new Response(JSON.stringify({ ok: true, data: parsed }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS(origin) },
    });

  } catch (e) {
    console.error('fetch error:', e);
    return errorRes('Internal server error: ' + e.message, 500, origin);
  }
}

function errorRes(msg, status, origin) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS(origin) },
  });
}
