// Vercel Serverless: 종목 에이전트 래퍼
import { runStockAgent } from '../agents/stock-agent.js';

export default async function handler(req, res) {
  try {
    const result = await runStockAgent();
    if (!result.ok) throw new Error('no data from stock-agent');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ok: true, data: result.data, ts: result.ts, count: result.count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
