#!/usr/bin/env node
/**
 * 배치 러너 — GitHub Actions에서 2시간마다 실행
 * 오케스트레이터를 호출하여 모든 에이전트 순차 실행
 */
import { runOrchestrator } from '../agents/orchestrator.js';

const options = {
  runInsights: (process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY) ? true : false,
};

console.log(`[batch-runner] ${new Date().toISOString()} 시작`);

runOrchestrator(options)
  .then(report => {
    console.log('[batch-runner] 완료:', JSON.stringify(report));
    process.exit(0);
  })
  .catch(e => {
    console.error('[batch-runner] 치명적 오류:', e.message);
    process.exit(1);
  });
