/**
 * 인사이트 에이전트 (Insight Agent)
 * LLM: 사용 (Claude Sonnet) — 이벤트 × 주가 데이터 분석
 * 현재: LLM stub — ANTHROPIC_API_KEY 있으면 실제 분석 실행
 * 역할: 이벤트 일정 + 주가 현황 → 방향성 분석 + 시나리오 카드
 */

const SYSTEM_PROMPT = `당신은 한국 주식시장 이벤트 분석 전문가입니다.
젠슨 황 방한 일정을 바탕으로 관련 주식의 방향성을 분석합니다.

분석 시 고려사항:
1. 이벤트가 해당 기업에 미치는 사업적 의미
2. 현재 주가의 선반영 정도 (이미 많이 올랐는가)
3. 이벤트 미실현 시 리스크
4. 유사 NVIDIA 파트너십 발표 사례

반드시 다음을 명시: "본 분석은 AI가 생성한 정보이며 투자 권유가 아닙니다."`;

/**
 * 단일 이벤트에 대한 인사이트 생성
 * @param {Object} event - events.json 이벤트 객체
 * @param {Object} stockData - runStockAgent() 결과의 data 필드
 * @returns {Promise<Object|null>} 인사이트 객체 또는 null
 */
export async function generateInsight(event, stockData) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // LLM 미연결: placeholder 반환
    return {
      summary: '인사이트 에이전트 준비 중 (ANTHROPIC_API_KEY 필요)',
      meaning: [],
      stock_view: { direction: 'neutral', rationale: 'LLM 미연결', already_priced: '알 수 없음', upside_scenario: '-', downside_scenario: '-' },
      confidence: 0,
      disclaimer: true,
      _stub: true,
    };
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  const stockSummary = event.related_stocks
    ?.filter(s => stockData[s.code])
    .map(s => {
      const d = stockData[s.code];
      return `${s.name}(${s.code}): 현재가 ${d.px}원, 방한확정比 ${d.v >= 0 ? '+' : ''}${d.v}%, 뉴스比 ${d.nw >= 0 ? '+' : ''}${d.nw}%`;
    }).join('\n') || '관련 주가 데이터 없음';

  try {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `이벤트: ${event.title?.ko}\n신뢰도: ${event.confidence_label?.ko}\n매체수: ${event.source_count}\n\n주가현황:\n${stockSummary}\n\nJSON으로 분석 반환: { summary, meaning(배열), stock_view: { direction, rationale, already_priced, upside_scenario, downside_scenario }, confidence(0-1), disclaimer }`
      }]
    });

    const parsed = JSON.parse(resp.content[0].text);
    return { ...parsed, _llm: true, generatedAt: new Date().toISOString() };
  } catch (e) {
    console.log(`[insight-agent] 인사이트 생성 실패: ${e.message}`);
    return null;
  }
}

/**
 * 인사이트 에이전트 통합 실행
 * @param {Array} events - events.json events 배열
 * @param {Object} stockData - runStockAgent() 결과
 * @returns {Promise<Object>} eventId → insight 매핑
 */
export async function runInsightAgent(events, stockData) {
  const insights = {};
  const targets = events.filter(e =>
    e.views?.news_card &&
    e.related_stocks?.length > 0 &&
    !e.insight &&
    ['likely', 'confirmed', 'expected'].includes(e.confidence)
  );

  for (const event of targets.slice(0, 5)) { // 배치당 최대 5개
    const insight = await generateInsight(event, stockData);
    if (insight) insights[event.id] = insight;
  }

  return insights;
}
