/**
 * 오케스트레이터 (Orchestrator)
 * LLM: 사용 (Claude Sonnet) — 에이전트 호출 순서/조건 판단
 * 역할: 모든 서브에이전트 조율 → events.json 통합 업데이트
 *
 * 실행 흐름:
 *   0. check_event_status — 이벤트 시간 경과 시 자동 상태 전환
 *   1. news-agent   → RSS 수집 + events.json 업데이트
 *   2. stock-agent  → 현재 주가 확인
 *   3. map-agent    → events.json → 지도 데이터 확인
 *   4. insight-agent → pre/post 분기 인사이트 생성 (LLM 있을 때만)
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
 * Step 0: 이벤트 상태 자동 전환
 * - end_datetime 경과 → completed
 * - datetime 1시간 전 → in_progress 준비 (pre_insight 플래그)
 * @returns {{ changed: number, needsPreInsight: string[], needsPostInsight: string[] }}
 */
export function checkEventStatus(eventsData) {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  let changed = 0;
  const needsPreInsight = [];
  const needsPostInsight = [];

  for (const event of eventsData.events) {
    if (!event.views?.timeline) continue;

    const start = event.datetime ? new Date(event.datetime).getTime() : null;
    const end   = event.end_datetime ? new Date(event.end_datetime).getTime() : (start ? start + 2 * ONE_HOUR : null);

    // 이벤트 종료 → completed
    if (end && now > end && event.status !== 'completed') {
      event.status = 'completed';
      event.status_label = { ko: '완료', en: 'done' };
      console.log(`  [orchestrator] 상태 전환: ${event.id} → completed`);
      changed++;
      // post_insight 미생성 시 생성 요청
      if (!event.post_insight) needsPostInsight.push(event.id);
    }

    // 이벤트 시작 1시간 전 → pre_insight 갱신 필요
    if (start && now > start - ONE_HOUR && now < start && !event.pre_insight) {
      needsPreInsight.push(event.id);
    }

    // 이벤트 시작 → in_progress
    if (start && end && now >= start && now <= end && event.status === 'upcoming') {
      event.status = 'in_progress';
      event.status_label = { ko: '진행중', en: 'live' };
      console.log(`  [orchestrator] 상태 전환: ${event.id} → in_progress`);
      changed++;
    }
  }

  return { changed, needsPreInsight, needsPostInsight };
}

/**
 * 오케스트레이터 메인 실행
 * @param {{ runInsights?: boolean }} options
 */
export async function runOrchestrator(options = {}) {
  const start = Date.now();
  console.log(`\n[orchestrator] 시작 ${new Date().toISOString()}`);
  const LLM_KEY = process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY;
  console.log(`[orchestrator] 모드: ${LLM_KEY ? 'LLM 활성화 (Groq)' : '기본 모드'}`);

  const report = { newsCards: 0, autoTimelineAdded: 0, pendingTimelineCount: 0, stockCount: 0, insights: 0, statusChanges: 0, errors: [] };

  // ── Step 0: 이벤트 상태 자동 전환 ──
  try {
    console.log('\n[orchestrator] Step 0: 이벤트 상태 확인');
    let eventsData = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    const statusResult = checkEventStatus(eventsData);
    report.statusChanges = statusResult.changed;

    if (statusResult.changed > 0) {
      eventsData.updatedAt = new Date().toISOString();
      eventsData.updatedBy = 'orchestrator-status';
      fs.writeFileSync(EVENTS_PATH, JSON.stringify(eventsData, null, 2));
    }
    console.log(`[orchestrator] 상태 변경: ${statusResult.changed}개, pre_insight 필요: ${statusResult.needsPreInsight.length}개, post_insight 필요: ${statusResult.needsPostInsight.length}개`);

    // 상태 정보를 options에 전달
    options._needsPreInsight  = statusResult.needsPreInsight;
    options._needsPostInsight = statusResult.needsPostInsight;
  } catch (e) {
    report.errors.push(`status-check: ${e.message}`);
    console.error(`[orchestrator] 상태 확인 오류: ${e.message}`);
  }

  // ── Step 1: 뉴스 에이전트 ──
  let pendingTimeline = [];
  try {
    console.log('\n[orchestrator] Step 1: 뉴스 에이전트');
    const newsResult = await runNewsAgent(EVENTS_PATH);
    report.newsCards = newsResult.newCards;
    report.autoTimelineAdded = newsResult.autoTimelineAdded || 0;
    pendingTimeline = newsResult.pendingTimeline || [];
    report.pendingTimelineCount = pendingTimeline.length;
    console.log(`[orchestrator] 새 카드: ${newsResult.newCards}개, auto-timeline: ${report.autoTimelineAdded}개, pending: ${report.pendingTimelineCount}개, 수집: ${newsResult.totalArticles}개`);
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
  if (options.runInsights && (process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY)) {
    try {
      console.log('\n[orchestrator] Step 4: 인사이트 에이전트');
      const eventsData = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
      const insights = await runInsightAgent(eventsData.events, stockData, {
        forcePreIds:  options._needsPreInsight  || [],
        forcePostIds: options._needsPostInsight || [],
      });
      report.insights = Object.keys(insights.pre || {}).length + Object.keys(insights.post || {}).length;

      if (report.insights > 0) {
        eventsData.events = eventsData.events.map(e => {
          let updated = { ...e };
          if (insights.pre?.[e.id])  updated.pre_insight  = insights.pre[e.id];
          if (insights.post?.[e.id]) updated.post_insight = insights.post[e.id];
          // legacy insight 필드도 최신 인사이트로 동기화
          updated.insight = insights.post?.[e.id] || insights.pre?.[e.id] || e.insight;
          return updated;
        });
        eventsData.updatedAt = new Date().toISOString();
        fs.writeFileSync(EVENTS_PATH, JSON.stringify(eventsData, null, 2));
      }
      console.log(`[orchestrator] 인사이트 ${report.insights}개 생성 (pre: ${Object.keys(insights.pre||{}).length}, post: ${Object.keys(insights.post||{}).length})`);
    } catch (e) {
      report.errors.push(`insight-agent: ${e.message}`);
      console.error(`[orchestrator] 인사이트 에이전트 오류: ${e.message}`);
    }
  }

  // ── Step 5: 정보 에이전트 (메타 업데이트) ──
  try {
    const note = `자동 배치: 뉴스 ${report.newsCards}건, 주가 ${report.stockCount}개, 인사이트 ${report.insights}개, 상태변경 ${report.statusChanges}개`;
    appendChangelog(META_PATH, note, 'orchestrator');
    runInfoAgent(META_PATH);
    // [heartbeat] 매 run 폴링 시각 + 결과 — newsCards=0이어도 "폴링은 살아있음" 신호
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    meta.lastPolledAt = new Date().toISOString();
    meta.lastPollReport = {
      newsCards: report.newsCards,
      autoTimelineAdded: report.autoTimelineAdded || 0,
      pendingTimelineCount: report.pendingTimelineCount || 0,
      stockCount: report.stockCount,
      insights: report.insights,
      statusChanges: report.statusChanges,
      errors: report.errors.length,
    };
    // pending_timeline 큐 — 페이지에서 "검토 대기" 표시용
    meta.pending_timeline = pendingTimeline;
    // 연속 zero-news streak 카운터 (RSS 장애 vs 자연스러운 무뉴스 구분)
    if (report.newsCards === 0 && report.statusChanges === 0) {
      meta.zeroNewsStreak = (meta.zeroNewsStreak || 0) + 1;
    } else {
      meta.zeroNewsStreak = 0;
    }
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
    console.log('\n[orchestrator] Step 5: meta.json 업데이트 완료 (heartbeat 포함)');
  } catch (e) {
    report.errors.push(`info-agent: ${e.message}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n[orchestrator] 완료 ${elapsed}s | 오류: ${report.errors.length}개`);
  if (report.errors.length) console.error('[orchestrator] 오류 목록:', report.errors);

  return report;
}
