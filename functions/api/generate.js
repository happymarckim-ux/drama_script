/**
 * Cloudflare Pages Function — /api/generate
 * 프론트에서 API 키 없이 드라마 기획서를 AI로 생성
 */

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  let body;
  try { body = await request.json(); } catch {
    return jsonRes({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const { platform, episodes, runtime, genre, title, logline, extra, chars } = body;
  if (!title || !logline) {
    return jsonRes({ ok: false, error: 'title and logline are required' }, 400, corsHeaders);
  }

  const apiKey = env.OPENAI_API_KEY || env.GENSPARK_TOKEN;
  const baseUrl = env.LLM_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1';
  if (!apiKey) return jsonRes({ ok: false, error: 'Server not configured' }, 500, corsHeaders);

  const epCount = parseInt(episodes) || 8;
  const charDesc = (chars || []).map(c =>
    `- ${c.label}: ${c.name}(${c.age}) / ${c.job} / ${c.personality}`
  ).join('\n');

  const systemPrompt = `당신은 15년 경력의 K-드라마 전문 작가입니다. 주어진 설정으로 완성도 높은 드라마 기획서를 한국어로 작성합니다. 반드시 요청한 JSON 형식만 반환하고, JSON 외 다른 텍스트나 마크다운 코드블록은 절대 포함하지 마세요.`;

  const userPrompt = `다음 설정으로 K-드라마 기획서를 작성해 주세요.

[설정]
플랫폼: ${platform || 'OTT 오리지널'}
총 회차: ${epCount}부작 / 회당 ${runtime || 60}분
장르: ${genre || '로맨틱 코미디'}
제목: ${title}
로그라인: ${logline}
추가 설정: ${extra || '없음'}
인물:
${charDesc || '없음'}

아래 JSON 스키마로 정확히 반환하세요 (마크다운 없이 순수 JSON만):
{
  "logline": "한 줄 로그라인(80자 이내)",
  "synopsis": "전체 줄거리(200~300자)",
  "conflicts": [
    {"label":"갈등명","color":"red","desc":"50자 이내 설명"},
    {"label":"갈등명","color":"gold","desc":"50자 이내 설명"},
    {"label":"갈등명","color":"teal","desc":"50자 이내 설명"},
    {"label":"갈등명","color":"ink","desc":"50자 이내 설명"}
  ],
  "stats": {
    "budget": "총 제작비 표기(예:127.5억)",
    "scenes": "총 씬 수(예:200씬)",
    "ppl": "PPL 수익(예:6.5억)",
    "budgetRaw": 1275000,
    "pplRaw": 65000
  },
  "episodes": ${JSON.stringify(Array.from({length: epCount}, (_, i) => ({
    "num": i+1,
    "title": "회차 제목",
    "story": "줄거리",
    "ending": "엔딩 장면"
  })))},
  "script": [
    {
      "heading": "S# 1. 장소 (시간대)",
      "lines": [
        {"type":"action","text":"지문"},
        {"type":"dialog","char":"캐릭터","paren":"지시어","line":"대사"},
        {"type":"direction","text":"방향지시"}
      ]
    }
  ]
}

episodes는 ${epCount}개 전부, script는 1화 첫 3씬만 작성. 순수 JSON만 반환.`;

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.1',
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
      return jsonRes({ ok: false, error: `LLM error: ${resp.status} — ${errText.slice(0,200)}` }, 502, corsHeaders);
    }

    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/,'').trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); } catch(e) {
      return jsonRes({ ok: false, error: 'AI 응답 파싱 실패. 다시 시도해주세요.' }, 500, corsHeaders);
    }

    return jsonRes({ ok: true, data: parsed }, 200, corsHeaders);
  } catch(e) {
    return jsonRes({ ok: false, error: e.message }, 500, corsHeaders);
  }
}

export async function onRequestOptions({ request }) {
  const origin = request.headers.get('Origin') || '*';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function jsonRes(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
