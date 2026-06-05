/**
 * 정보 에이전트 (Info Agent)
 * LLM: 불필요 — 메타데이터 읽기/쓰기만 수행
 * 역할: meta.json 버전·업데이트 이력 관리
 */

import fs from 'fs';

/**
 * meta.json 읽기
 * @param {string} metaPath
 * @returns {Object} 메타데이터
 */
export function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return { version: '0.0.0', updatedAt: null, changelog: [] };
  }
}

/**
 * meta.json 업데이트 이력 추가
 * @param {string} metaPath
 * @param {string} note - 변경 내용
 * @param {string} updatedBy - 에이전트 이름
 */
export function appendChangelog(metaPath, note, updatedBy = 'agent') {
  const meta = readMeta(metaPath);
  meta.updatedAt = new Date().toISOString();
  meta.updatedBy = updatedBy;
  meta.changelog = [{
    version: meta.version,
    date: new Date().toISOString().slice(0, 10),
    note,
  }, ...(meta.changelog || [])].slice(0, 20); // 최대 20개 유지
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * 정보 에이전트 통합 실행
 * @param {string} metaPath
 * @returns {Object} 현재 메타데이터
 */
export function runInfoAgent(metaPath) {
  return readMeta(metaPath);
}
