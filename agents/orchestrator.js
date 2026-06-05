/**
 * 오케스트레이터 (Orchestrator)
 * LLM: 사용 (Claude Sonnet) — 에이전트 호출 순서/조건 판단
 * 현재: 고정 파이프라인으로 동작 (Phase 3에서 LLM 판단 추가)
 * 역할: 모든 서브에이전트 조율 → events.json 통합 업데이트
 *
 * 실행 흐름:
 *   1. news-agent   → RSS 수집 + events.json 업데이트
 *   2. stock-agent  → 현재 주가 확인 (인사이트 에이전트 입력용)
 *   3. map-agent    → events.json → 지도 데이터 확인 (동기 처리)
 *   4. insight-agent → 이벤트 × 주가 → 인사이트 생성 (LLM 있을 때만)
 *   5. info-agent   → meta.json 업데이트 이력 기록
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { runNewsAgent }    from './news-agent.js';
import { runStockAgent }   from './stock-agent.js';
import { runMapAgent }     from './map-agent.js';
import { runInsightAgent } from './insight-agent.js';
import { runInfoAgent, appendChangelog } from './info-agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVENTS_PATH = path.join(ROOT, 'public', 'data', 'events.json');
const META_PATH   = path.join(ROOT, 'public', 'data', 'meta.json');

/**
 * 오케스트레이터 메인 실행
 * @param {{ runInsights?: boolean }} options
 */
export async function runOrchestrator(options = {}) {
  const start = Date.now();
  console.log(`\n[orchestrator] 시작 ${new Date().toISOString()}`);
  console.log(`[orchestrator] 모드: ${process.env.ANTHROPIC_API_KEY ? 'LLM 활성화' : '기본 모드'}`);

  const report = { newsCards: 0, stockCount: 0, insights: 0, errors: [] };

  // ── Step 1: 뉴스 에이전트 ──
  try {
    console.log('\n[orchestrator] Step 1: 뉴스 에이전트');
    const newsResult = await runNewsAgent(EVENTS_PATH);
    report.newsCards = newsResult.newCards;
    console.log(`[orchestrator] 새 카드: ${newsResult.newCards}개, 수집: ${newsResult.totalArticles}개`);
  } catch (e) {
    report.errors.push(`news-agent: ${e.message}`);
    console.error(`[orchestrator] 뉴스 에이전트 오류: ${e.message}`);
  }

  // ── Step 2: 종목 에이전트 ──
  let stockData = {};
  try {
    console.log('\n[orchestrator] Step 2: 종목 에이전트');
    const stockResult = await runStockAgent();
    stockData = stockResult.data;
    report.stockCount = stockResult.count;
    console.log(`[orchestrator] 주가 ${stockResult.count}개 수집`);
  } catch (e) {
    report.errors.push(`stock-agent: ${e.message}`);
    console.error(`[orchestrator] 종목 에이전트 오류: ${e.message}`);
  }

  // ── Step 3: 지도 에이전트 (동기) ──
  try {
    console.log('\n[orchestrator] Step 3: 지도 에이전트');
    const eventsData = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    const mapResult = runMapAgent(eventsData.events);
    console.log(`[orchestrator] ROUTE ${mapResult.route.length}개, MAP_EXTRAS ${mapResult.mapExtras.length}개`);
  } catch (e) {
    report.errors.push(`map-agent: ${e.message}`);
    console.error(`[orchestrator] 지도 에이전트 오류: ${e.message}`);
  }

  // ── Step 4: 인사이트 에이전트 (LLM 있을 때만) ──
  if (options.runInsights && process.env.ANTHROPIC_API_KEY) {
    try {
      console.log('\n[orchestrator] Step 4: 인사이트 에이전트');
      const eventsData = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
      const insights = await runInsightAgent(eventsData.events, stockData);
      report.insights = Object.keys(insights).length;

      if (report.insights > 0) {
        // 인사이트를 events.json에 반영
        eventsData.events = eventsData.events.map(e =>
          insights[e.id] ? { ...e, insight: insights[e.id] } : e
        );
        eventsData.updatedAt = new Date().toISOString();
        fs.writeFileSync(EVENTS_PATH, JSON.stringify(eventsData, null, 2));
      }
      console.log(`[orchestrator] 인사이트 ${report.insights}개 생성`);
    } catch (e) {
      report.errors.push(`insight-agent: ${e.message}`);
      console.error(`[orchestrator] 인사이트 에이전트 오류: ${e.message}`);
    }
  }

  // ── Step 5: 정보 에이전트 (메타 업데이트) ──
  try {
    const note = `자동 배치: 뉴스 ${report.newsCards}건, 주가 ${report.stockCount}개, 인사이트 ${report.insights}개`;
    appendChangelog(META_PATH, note, 'orchestrator');
    runInfoAgent(META_PATH);
    console.log('\n[orchestrator] Step 5: meta.json 업데이트 완료');
  } catch (e) {
    report.errors.push(`info-agent: ${e.message}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n[orchestrator] 완료 ${elapsed}s | 오류: ${report.errors.length}개`);
  if (report.errors.length) console.error('[orchestrator] 오류 목록:', report.errors);

  return report;
}
