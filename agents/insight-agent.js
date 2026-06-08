/**
 * 인사이트 에이전트 (Insight Agent)
 * LLM: Groq Llama 3.3 70B — 이벤트 × 주가 데이터 분석
 * 이벤트 상태별 3단계 프롬프트 분기:
 *   - upcoming/in_progress → pre_insight (기대감·시나리오·리스크)
 *   - completed           → post_insight (결과 분석·주가 반응 해석)
 */

// Groq API 헬퍼 (OpenAI 호환, fetch 사용)
async function callGroq(messages, maxTokens = 900) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Groq API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

const PRE_SYSTEM = `당신은 한국 주식시장 이벤트 분석 전문가입니다.
젠슨 황 방한 예정 일정을 바탕으로 관련 주식의 기대 방향성과 시나리오를 분석합니다.

분석 시 고려사항:
1. 이벤트가 해당 기업에 미치는 잠재적 사업적 의미
2. 현재 주가의 선반영(already priced in) 정도
3. 이벤트 미실현/실망 시 하방 리스크
4. 유사 NVIDIA 파트너십 발표 선례

출력 형식: JSON만 반환. "본 분석은 AI가 생성한 정보이며 투자 권유가 아닙니다." 포함 필수.`;

const POST_SYSTEM = `당신은 한국 주식시장 이벤트 사후 분석 전문가입니다.
젠슨 황 방한 완료 이벤트를 바탕으로 실제 결과와 주가 반응을 분석합니다.

분석 시 고려사항:
1. 이벤트에서 실제로 발표/언급된 내용
2. 기대 대비 실제 결과 (over/under deliver)
3. 주가의 실제 반응과 그 해석
4. 향후 MOU·파트너십·투자 발표 가능성

출력 형식: JSON만 반환. "본 분석은 AI가 생성한 정보이며 투자 권유가 아닙니다." 포함 필수.`;

function buildPrePrompt(event, stockSummary, prevContext) {
  return `이벤트 (예정): "${event.title?.ko}"
전략적 의도: ${event.strategic_intent || '미기재'}
임팩트 레벨: ${event.impact_level || 'medium'}
예정 일시: ${event.datetime_display?.ko}

이전 이벤트 맥락 (직전 2개):
${prevContext || '없음'}

주가 현황:
${stockSummary}

다음 JSON 형식으로 pre_insight 분석 반환:
{
  "summary": "2-3문장 핵심 요약",
  "meaning": ["의미1", "의미2", "의미3"],
  "stock_view": {
    "direction": "bullish|bearish|neutral",
    "rationale": "방향성 근거",
    "price_target_range": { "low": 숫자, "base": 숫자, "high": 숫자 },
    "catalyst_timeline": "촉매 예상 시기",
    "already_priced": true|false,
    "already_priced_ratio": 0.0~1.0,
    "upside_scenario": "상승 시나리오",
    "downside_scenario": "하락 시나리오"
  },
  "confidence": 0.0~1.0,
  "disclaimer": "본 분석은 AI가 생성한 정보이며 투자 권유가 아닙니다."
}`;
}

function buildPostPrompt(event, stockSummary, newsSummary) {
  return `이벤트 (완료): "${event.title?.ko}"
전략적 의도: ${event.strategic_intent || '미기재'}
임팩트 레벨: ${event.impact_level || 'medium'}

이벤트 후 주가 현황:
${stockSummary}

관련 뉴스 요약:
${newsSummary || '수집된 뉴스 없음'}

다음 JSON 형식으로 post_insight 분석 반환:
{
  "summary": "이벤트 결과 2-3문장 요약",
  "meaning": ["실제 의미1", "실제 의미2"],
  "actual_outcome": "이벤트에서 실제 발생한 내용",
  "vs_expectation": "기대 대비 평가: 상회|부합|하회",
  "stock_view": {
    "direction": "bullish|bearish|neutral",
    "rationale": "주가 방향 근거",
    "price_target_range": { "low": 숫자, "base": 숫자, "high": 숫자 },
    "catalyst_timeline": "다음 촉매 예상 시기",
    "already_priced": true|false,
    "already_priced_ratio": 0.0~1.0,
    "upside_scenario": "후속 상승 시나리오",
    "downside_scenario": "후속 하락 시나리오"
  },
  "confidence": 0.0~1.0,
  "disclaimer": "본 분석은 AI가 생성한 정보이며 투자 권유가 아닙니다."
}`;
}

/**
 * 단일 이벤트 pre_insight 생성
 */
async function generatePreInsight(event, stockData, prevContext) {
  const stockSummary = (event.related_tickers || [])
    .filter(code => stockData[code])
    .map(code => {
      const d = stockData[code];
      const ptrStr = d.ptr ? ` | 통계 레인지 ${d.ptr.low.toLocaleString()}~${d.ptr.high.toLocaleString()}원` : '';
      return `${code}: 현재가 ${d.px}원, 방한확정比 ${d.v >= 0 ? '+' : ''}${d.v}%, 뉴스比 ${d.nw >= 0 ? '+' : ''}${d.nw}%${ptrStr}`;
    }).join('\n') || '관련 주가 데이터 없음';

  const text = await callGroq([
    { role: 'system', content: PRE_SYSTEM },
    { role: 'user', content: buildPrePrompt(event, stockSummary, prevContext) }
  ]);

  const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
  return { ...parsed, _mode: 'pre', _llm: true, _model: 'llama-3.3-70b', generatedAt: new Date().toISOString() };
}

/**
 * 단일 이벤트 post_insight 생성
 */
async function generatePostInsight(event, stockData, recentNews) {
  const stockSummary = (event.related_tickers || [])
    .filter(code => stockData[code])
    .map(code => {
      const d = stockData[code];
      const ptrStr = d.ptr ? ` | 통계 레인지 ${d.ptr.low.toLocaleString()}~${d.ptr.high.toLocaleString()}원` : '';
      return `${code}: 현재가 ${d.px}원, 방한확정比 ${d.v >= 0 ? '+' : ''}${d.v}%, 뉴스比 ${d.nw >= 0 ? '+' : ''}${d.nw}%${ptrStr}`;
    }).join('\n') || '관련 주가 데이터 없음';

  const newsSummary = (recentNews || [])
    .filter(n => {
      const title = n.title?.ko || n.t || '';
      return (event.title?.ko || '').split(' ').some(w => w.length > 2 && title.includes(w));
    })
    .slice(0, 5)
    .map(n => `- ${n.title?.ko || n.t}`)
    .join('\n');

  const text = await callGroq([
    { role: 'system', content: POST_SYSTEM },
    { role: 'user', content: buildPostPrompt(event, stockSummary, newsSummary) }
  ]);

  const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
  return { ...parsed, _mode: 'post', _llm: true, _model: 'llama-3.3-70b', generatedAt: new Date().toISOString() };
}

/**
 * 인사이트 에이전트 통합 실행
 * @param {Array} events - events.json events 배열
 * @param {Object} stockData - runStockAgent() 결과
 * @param {{ forcePreIds?: string[], forcePostIds?: string[] }} opts
 * @returns {Promise<{ pre: Object, post: Object }>} eventId → insight 매핑
 */
export async function runInsightAgent(events, stockData, opts = {}) {
  const result = { pre: {}, post: {} };

  if (!process.env.GROQ_API_KEY) {
    console.log('  [insight-agent] LLM 미연결 — 스킵');
    return result;
  }

  // 완료된 이벤트 중 post_insight 미생성 또는 강제 재생성 대상
  const postTargets = events.filter(e =>
    e.views?.timeline &&
    (e.related_tickers?.length > 0) &&
    e.status === 'completed' &&
    (!e.post_insight || opts.forcePostIds?.includes(e.id))
  ).slice(0, 4);

  // 예정 이벤트 중 pre_insight 미생성 또는 강제 재생성 대상
  const preTargets = events.filter(e =>
    e.views?.timeline &&
    (e.related_tickers?.length > 0 || e.impact_level === 'high') &&
    (e.status === 'upcoming' || e.status === 'in_progress') &&
    (!e.pre_insight || opts.forcePreIds?.includes(e.id))
  ).slice(0, 4);

  // 슬라이딩 윈도우 컨텍스트 (직전 2개 완료 이벤트 요약)
  const completedEvents = events.filter(e => e.status === 'completed' && e.views?.timeline);
  const prevContext = completedEvents.slice(-2)
    .map(e => `• ${e.title?.ko}: ${e.post_insight?.actual_outcome || e.summary?.ko?.[0] || ''}`)
    .join('\n');

  // post_insight 생성
  for (const event of postTargets) {
    try {
      console.log(`  [insight-agent] post_insight: ${event.id}`);
      result.post[event.id] = await generatePostInsight(event, stockData, events);
    } catch (e) {
      console.log(`  [insight-agent] post 실패 (${event.id}): ${e.message}`);
    }
  }

  // pre_insight 생성
  for (const event of preTargets) {
    try {
      console.log(`  [insight-agent] pre_insight: ${event.id}`);
      result.pre[event.id] = await generatePreInsight(event, stockData, prevContext);
    } catch (e) {
      console.log(`  [insight-agent] pre 실패 (${event.id}): ${e.message}`);
    }
  }

  return result;
}

// 하위호환: 기존 단일 generateInsight 인터페이스 유지
export async function generateInsight(event, stockData) {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    if (event.status === 'completed') {
      return await generatePostInsight(event, stockData, []);
    }
    return await generatePreInsight(event, stockData, '');
  } catch (e) {
    console.log(`[insight-agent] 실패: ${e.message}`);
    return null;
  }
}
