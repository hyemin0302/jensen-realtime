/**
 * 뉴스 에이전트 (News Agent)
 * LLM: 사용 (Claude Haiku) — RSS → 구조화 카드 자동 생성
 * 역할: RSS 수집 → 본문 크롤링 → 키워드 필터 → events.json 후보 생성
 */

import fs from 'fs';
import path from 'path';

// ── 기사 본문 크롤링 ──────────────────────────────────────

function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ').trim();
}

function extractBody(html) {
  // article/main → 사이트별 클래스 → body 순으로 시도
  const patterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /class="(?:article[_-]?(?:body|txt|content|view)|news[_-]?(?:body|content|detail|view|article)|view[_-]?cont|cont[_-]?detail)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/i,
    /<div[^>]+id="(?:article[_-]?body|article[_-]?view|newsContent|news_content)"[^>]*>([\s\S]*?)<\/div>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]?.length > 200) return htmlToText(m[1]).slice(0, 3000);
  }
  return htmlToText(html).slice(0, 3000);
}

async function fetchFullText(url) {
  if (!url || url === '#') return '';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return '';
    return extractBody(await res.text());
  } catch {
    return '';
  }
}

/**
 * 기사 배열에 본문(fullText) 추가 — 동시 5개, 배치 간 400ms 대기
 * @param {Array} items
 * @returns {Promise<Array>}
 */
export async function enrichWithFullText(items, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const texts = await Promise.all(batch.map(item => fetchFullText(item.u)));
    texts.forEach((fullText, j) => results.push({ ...batch[j], fullText }));
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, 400));
  }
  const ok = results.filter(r => r.fullText).length;
  console.log(`[news-agent] 본문 크롤링: ${ok}/${results.length}건 성공`);
  return results;
}

const FEEDS = [
  { url: 'https://www.yna.co.kr/rss/economy.xml',        src: '연합뉴스' },
  { url: 'https://www.hankyung.com/feed/all-news',        src: '한국경제' },
  { url: 'https://www.newsis.com/rss/realnews.xml',       src: '뉴시스'  },
  { url: 'https://rss.mt.co.kr/mt/mt.xml',               src: '머니투데이' },
  { url: 'https://biz.chosun.com/site/data/rss/rss.xml', src: '조선비즈' },
  { url: 'https://www.mk.co.kr/rss/30000001/',            src: '매일경제' },
  { url: 'https://n.news.naver.com/rss/news.xml',        src: '네이버뉴스' },
];

const KEYWORDS = [
  '젠슨황', '젠슨 황', 'Jensen Huang',
  '엔비디아 방한', 'NVIDIA 방한', '엔비디아 CEO',
  '젠슨황 방한', '젠슨 황 방한', '젠슨황 한국',
];

const STOCK_MAP = {
  '삼성전자': ['005930','005935'], 'Samsung': ['005930','005935'],
  'SK하이닉스': ['000660'],        'SK hynix': ['000660'],
  'LG전자': ['066570','066575'],   'LG Electronics': ['066570'],
  '네이버': ['035420'],            'Naver': ['035420'],
  '현대차': ['005380'],            'Hyundai': ['005380'],
  '두산로보틱스': ['454910'],       'Doosan Robotics': ['454910'],
  '두산': ['000150','454910'],     'Doosan': ['000150'],
  'SK텔레콤': ['017670'],          'SKT': ['017670'],
};

function extractTag(xml, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plainRe  = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
  return (xml.match(cdataRe) || xml.match(plainRe) || [])[1]?.trim() || '';
}

function parseRSS(xml, src) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = extractTag(b, 'title');
    const link  = extractTag(b, 'link') || extractTag(b, 'guid');
    const desc  = extractTag(b, 'description').replace(/<[^>]+>/g, '').slice(0, 400);
    const date  = extractTag(b, 'pubDate');
    if (!title) continue;
    const text = title + ' ' + desc;
    if (!KEYWORDS.some(kw => text.includes(kw))) continue;

    const stocks = new Set();
    for (const [kw, codes] of Object.entries(STOCK_MAP)) {
      if (text.includes(kw)) codes.forEach(c => stocks.add(c));
    }

    items.push({
      s: src, t: title, d: desc, u: link,
      m: date ? new Date(date).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '',
      ts: date ? new Date(date).getTime() : 0,
      stocks: [...stocks],
    });
  }
  return items;
}

/**
 * RSS 수집 실행
 * @returns {Promise<Array>} 수집된 뉴스 아이템 배열
 */
export async function collectRSS() {
  const all = [];
  for (const { url, src } of FEEDS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { console.log(`  SKIP ${src}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const items = parseRSS(xml, src);
      console.log(`  ${src}: ${items.length}개`);
      all.push(...items);
    } catch (e) {
      console.log(`  ERROR ${src}: ${e.message}`);
    }
  }

  // 중복 제거 후 최신순 정렬
  const seen = new Set();
  return all.filter(item => {
    const key = item.t.slice(0, 25);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => b.ts - a.ts).slice(0, 60);
}

/**
 * [자동화] LLM으로 타임라인 이벤트를 뉴스에서 자동 업데이트
 * 기존 timeline 이벤트 중 아직 completed가 아닌 것 + 매칭 기사 → LLM 판단 → status/sources 업데이트
 * @param {Array} events - events.json events 배열 (수정됨)
 * @param {Array} articles - collectRSS() 결과
 * @returns {Promise<number>} 업데이트된 이벤트 수
 */
export async function updateTimelineFromNews(events, articles) {
  if (!articles.length) return 0;
  const targets = events.filter(e =>
    e.views?.timeline &&
    e.status !== 'completed' &&
    e.timeline_order != null
  );
  if (!targets.length) return 0;

  let updatedCount = 0;

  // LLM 없이: 키워드 매칭으로 sources만 보강
  if (!process.env.ANTHROPIC_API_KEY) {
    for (const event of targets) {
      const keywords = [
        event.title?.ko, event.location?.name?.ko,
        ...(event.key_persons || [])
      ].filter(Boolean);
      const matched = articles.filter(a => {
        const text = a.t + ' ' + (a.d || '') + ' ' + (a.fullText || '');
        return keywords.some(kw => kw && text.includes(kw));
      });
      if (!matched.length) continue;

      const existingUrls = new Set((event.sources || []).map(s => s.url));
      const newSources = matched
        .filter(a => a.u && !existingUrls.has(a.u))
        .map(a => ({ publisher: { ko: a.s, en: a.s }, title: { ko: a.t, en: a.t }, url: a.u, time: a.m }));

      if (newSources.length) {
        event.sources = [...(event.sources || []), ...newSources];
        event.source_count = (event.source_count || 0) + newSources.length;
        event.is_new = true;
        updatedCount++;
        console.log(`  [news-agent] 소스 보강: ${event.title?.ko} (+${newSources.length}건)`);
      }
    }
    return updatedCount;
  }

  // LLM 모드: Haiku로 이벤트 확정/완료 판단
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  for (const event of targets) {
    const keywords = [
      event.title?.ko, event.location?.name?.ko,
      ...(event.key_persons || [])
    ].filter(Boolean);
    const candidates = articles.filter(a =>
      keywords.some(kw => kw && (a.t.includes(kw) || a.d.includes(kw)))
    );
    if (!candidates.length) continue;

    const articleList = candidates.slice(0, 5)
      .map((a, i) => `[${i+1}] ${a.s}: ${a.t} — ${a.d}`).join('\n');

    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `이벤트: "${event.title?.ko}" (현재상태: ${event.status})\n\n관련 기사:\n${articleList}\n\n이 기사들이 위 이벤트가 실제로 진행됐거나 완료됐음을 보도하는가? 기사 본문까지 참고해 판단해줘.\nJSON으로만 답변: { "confirmed": true/false, "completed": true/false, "reason": "한 문장" }`
        }]
      });

      let parsed;
      try { parsed = JSON.parse(resp.content[0].text); } catch { continue; }

      const existingUrls = new Set((event.sources || []).map(s => s.url));
      const newSources = candidates
        .filter(a => a.u && !existingUrls.has(a.u))
        .map(a => ({ publisher: { ko: a.s, en: a.s }, title: { ko: a.t, en: a.t }, url: a.u, time: a.m }));

      if (newSources.length) {
        event.sources = [...(event.sources || []), ...newSources];
        event.source_count = (event.source_count || 0) + newSources.length;
        event.is_new = true;
      }

      if (parsed.completed && event.status !== 'completed') {
        event.status = 'completed';
        event.status_label = { ko: '완료', en: 'completed' };
        updatedCount++;
        console.log(`  [news-agent] 완료 확정: ${event.title?.ko}`);
      } else if (parsed.confirmed && event.confidence !== 'confirmed') {
        event.confidence = 'confirmed';
        event.confidence_label = { ko: '확정', en: 'confirmed' };
        updatedCount++;
        console.log(`  [news-agent] 확정 업데이트: ${event.title?.ko}`);
      } else if (newSources.length) {
        updatedCount++;
      }
    } catch (e) {
      console.log(`  [news-agent] 타임라인 업데이트 실패 (${event.id}): ${e.message}`);
    }
  }

  return updatedCount;
}

/**
 * [Phase 2 준비] LLM으로 뉴스 카드 자동 생성
 * ANTHROPIC_API_KEY 환경변수 있으면 LLM 사용, 없으면 기본 구조만 반환
 * @param {Array} articles - collectRSS() 결과
 * @returns {Promise<Array>} events.json 호환 이벤트 객체 배열
 */
export async function generateEventCards(articles) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // LLM 없이: 기본 구조로 변환만 수행
    console.log('  [news-agent] LLM 미연결 — 기본 구조 변환만 수행');
    return articles.map(a => ({
      id: `evt_auto_${a.ts}`,
      type: 'announcement',
      is_new: true,
      source_count: 1,
      status: 'planned',
      status_label: { ko: '속보', en: 'breaking' },
      confidence: 'auto',
      confidence_label: { ko: '자동수집', en: 'auto' },
      title: { ko: a.t, en: a.t },
      url: a.u || '',
      location: null,
      datetime: new Date(a.ts).toISOString(),
      datetime_display: { ko: a.m, en: a.m },
      timeline_order: null,
      timeline_badge: null,
      description: { ko: a.d || a.t, en: a.d || a.t },
      summary: { ko: [a.d || a.t], en: [a.d || a.t] },
      related_stocks: a.stocks.map(code => ({
        code, name: code, theme: { ko: '관련주', en: 'related' },
        brief: { ko: '자동 수집', en: 'auto-collected' }
      })),
      sources: [{ publisher: { ko: a.s, en: a.s }, title: { ko: a.t, en: a.t }, url: a.u, time: a.m }],
      insight: null,
      views: { timeline: false, news_card: true, map_pin: false },
      _auto: true,
    }));
  }

  // Phase 2: LLM 카드 생성 (ANTHROPIC_API_KEY 있을 때)
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const generated = [];

  for (const article of articles.slice(0, 10)) { // 배치당 최대 10개
    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `다음 기사를 분석해서 JSON으로 반환해줘. 필드: status(예정/완료/진행중), confidence(확정/유력/예상/미정), summary_ko(요약 2줄 배열), location(장소명 또는 null), persons(인물명 배열).\n\n제목: ${article.t}\n요약: ${article.d}\n본문: ${(article.fullText || '').slice(0, 800)}\n출처: ${article.s}\n\nJSON만 반환.`
        }]
      });
      const parsed = JSON.parse(resp.content[0].text);
      generated.push({
        id: `evt_llm_${article.ts}`,
        type: 'announcement',
        is_new: true,
        source_count: 1,
        status: parsed.status || 'planned',
        status_label: { ko: parsed.status || '예정', en: 'planned' },
        confidence: parsed.confidence || 'expected',
        confidence_label: { ko: parsed.confidence || '예상', en: 'expected' },
        title: { ko: article.t, en: article.t },
        url: article.u || '',
        location: parsed.location ? { name: { ko: parsed.location, en: parsed.location } } : null,
        datetime: new Date(article.ts).toISOString(),
        datetime_display: { ko: article.m, en: article.m },
        timeline_order: null,
        timeline_badge: null,
        description: { ko: article.d || article.t, en: article.d || article.t },
        summary: { ko: parsed.summary_ko || [article.d || article.t], en: [article.d || article.t] },
        related_stocks: article.stocks.map(code => ({ code, name: code, theme: { ko: '관련주', en: 'related' }, brief: { ko: '자동수집', en: 'auto' } })),
        sources: [{ publisher: { ko: article.s, en: article.s }, title: { ko: article.t, en: article.t }, url: article.u, time: article.m }],
        insight: null,
        views: { timeline: false, news_card: true, map_pin: false },
        _auto: true,
        _llm: true,
      });
    } catch (e) {
      console.log(`  [news-agent] LLM 카드 생성 실패: ${e.message}`);
    }
  }
  return generated;
}

/**
 * 뉴스 에이전트 메인 실행
 * events.json 업데이트 + public/data/news-live.json 저장
 */
export async function runNewsAgent(eventsPath) {
  console.log(`[news-agent] RSS 수집 시작`);
  const rssArticles = await collectRSS();
  console.log(`[news-agent] ${rssArticles.length}개 수집 완료`);

  // 본문 크롤링으로 fullText 보강 (동시 5개, 배치 간 400ms)
  const articles = await enrichWithFullText(rssArticles);

  // events.json 기존 이벤트 로드
  let eventsData = { events: [], feed: [] };
  try {
    eventsData = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
  } catch (e) { /* 없으면 빈 상태로 시작 */ }

  // ── 타임라인 이벤트 자동 업데이트 (기사 → 상태/소스 반영) ──
  const timelineUpdates = await updateTimelineFromNews(eventsData.events, articles);
  console.log(`[news-agent] 타임라인 업데이트: ${timelineUpdates}개`);

  const existingTitles = new Set(
    eventsData.events.map(e => (e.title?.ko || '').slice(0, 25))
  );

  // 새 이벤트 카드 생성 (타임라인에서 이미 처리된 기사 제외)
  const newCards = await generateEventCards(
    articles.filter(a => !existingTitles.has(a.t.slice(0, 25)))
  );

  if (newCards.length > 0 || timelineUpdates > 0) {
    eventsData.events = newCards.length > 0
      ? [...newCards, ...eventsData.events]
      : eventsData.events;
    eventsData.updatedAt = new Date().toISOString();
    eventsData.updatedBy = 'news-agent';
    fs.writeFileSync(eventsPath, JSON.stringify(eventsData, null, 2));
    if (newCards.length > 0) console.log(`[news-agent] ${newCards.length}개 새 카드 추가`);
  }

  // 하단 피드용 news-live.json도 동시 업데이트
  const feedPath = path.join(path.dirname(eventsPath), 'news-live.json');
  const feedOut = { updatedAt: new Date().toISOString(), count: articles.length, items: articles };
  fs.writeFileSync(feedPath, JSON.stringify(feedOut, null, 2));

  return { newCards: newCards.length, totalArticles: articles.length };
}
