import { getPublicCorsHeaders } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { redisPipeline } from './_upstash-json.js';

export const config = { runtime: 'edge' };

// Sorted-set archive written by api/vantage-refresh.js (archiveBriefSnapshot):
// member = trimmed JSON snapshot, score = Date.parse(generatedAt).
// The key string is duplicated there on purpose — importing vantage-refresh.js
// here would pull the seed scripts into this edge bundle.
const HISTORY_KEY = 'news:insights:history:v1';
const MAX_LIST_ENTRIES = 100;
const HEADLINE_MAX_CHARS = 140;
const KEPT_SIMILARITY_THRESHOLD = 0.5;
const DAY_MS = 24 * 60 * 60 * 1_000;

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** First sentence of the world brief, citations stripped, capped at 140 chars. */
export function headlineFromBrief(worldBrief) {
  const text = String(worldBrief || '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.!?,;:])/g, '$1')
    .trim();
  const first = splitSentences(text)[0] || text;
  if (first.length <= HEADLINE_MAX_CHARS) return first;
  return `${first.slice(0, HEADLINE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Diff units for a snapshot: briefStoryLines texts when present, otherwise
 * the sentence-split worldBrief (pre-#4921 payloads have no story lines).
 */
export function extractBriefLines(snapshot) {
  const storyLines = Array.isArray(snapshot?.briefStoryLines)
    ? snapshot.briefStoryLines
      .map((line) => (typeof line === 'string' ? line : line?.text || ''))
      .map((text) => text.trim())
      .filter(Boolean)
    : [];
  if (storyLines.length > 0) return storyLines;
  return splitSentences(snapshot?.worldBrief);
}

/** Lowercase, strip [n] citations and punctuation, collapse whitespace. */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[\d+\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text) {
  return new Set(normalizeText(text).split(' ').filter(Boolean));
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Pure diff between two archived snapshots (exported for tests).
 *
 * Units are brief lines (see extractBriefLines). Each line in `b` is greedily
 * matched to its most similar unmatched line in `a` by token Jaccard on
 * normalized text (lowercased, citations [n] and punctuation stripped);
 * similarity >= 0.5 counts as 'kept', otherwise the line is 'added'.
 * Unmatched `a` lines are 'removed'. A kept line carries changed:true when the
 * normalized texts still differ (i.e. more than citation/punctuation drift).
 *
 * Returns { a: {generatedAt}, b: {generatedAt}, added: string[],
 *   removed: string[], kept: [{ text, previousText, changed }] }.
 */
export function diffBriefSnapshots(snapA, snapB) {
  const linesA = extractBriefLines(snapA);
  const linesB = extractBriefLines(snapB);
  const tokensA = linesA.map(tokenSet);
  const tokensB = linesB.map(tokenSet);
  const matchedA = new Array(linesA.length).fill(false);

  const added = [];
  const kept = [];
  for (let j = 0; j < linesB.length; j += 1) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < linesA.length; i += 1) {
      if (matchedA[i]) continue;
      const score = jaccard(tokensA[i], tokensB[j]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestScore >= KEPT_SIMILARITY_THRESHOLD) {
      matchedA[bestIndex] = true;
      kept.push({
        text: linesB[j],
        previousText: linesA[bestIndex],
        changed: normalizeText(linesA[bestIndex]) !== normalizeText(linesB[j]),
      });
    } else {
      added.push(linesB[j]);
    }
  }
  const removed = linesA.filter((_, i) => !matchedA[i]);

  return {
    a: { generatedAt: snapA?.generatedAt ?? null },
    b: { generatedAt: snapB?.generatedAt ?? null },
    added,
    removed,
    kept,
  };
}

function parseMember(member) {
  try {
    const parsed = JSON.parse(member);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function pipelineEntryFailed(entry) {
  return !entry
    || typeof entry !== 'object'
    || Object.prototype.hasOwnProperty.call(entry, 'error')
    || !Object.prototype.hasOwnProperty.call(entry, 'result');
}

/** Load the full archive, oldest-first, as [{ generatedAtMs, snapshot }]. */
async function loadArchive(pipeline) {
  const results = await pipeline([['ZRANGE', HISTORY_KEY, '0', '-1', 'WITHSCORES']]);
  if (!results || pipelineEntryFailed(results[0])) return null;
  const flat = results[0].result;
  if (!Array.isArray(flat)) return [];
  const entries = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const snapshot = parseMember(flat[i]);
    const generatedAtMs = Number(flat[i + 1]);
    if (snapshot && Number.isFinite(generatedAtMs)) entries.push({ generatedAtMs, snapshot });
  }
  return entries;
}

/**
 * Resolve a diff selector against the archive (oldest-first entries):
 *   'latest'    → newest entry
 *   'yesterday' → entry closest to 24h before the newest
 *   ISO date    → entry whose generatedAt score matches exactly
 * Returns the entry, or null when it cannot be resolved.
 */
function resolveSelector(selector, entries) {
  if (entries.length === 0) return null;
  if (selector === 'latest') return entries[entries.length - 1];
  if (selector === 'yesterday') {
    const target = entries[entries.length - 1].generatedAtMs - DAY_MS;
    let best = null;
    for (const entry of entries) {
      if (!best || Math.abs(entry.generatedAtMs - target) < Math.abs(best.generatedAtMs - target)) {
        best = entry;
      }
    }
    return best;
  }
  const ms = Date.parse(selector);
  if (!Number.isFinite(ms)) return undefined; // signals a bad param, not a miss
  return entries.find((entry) => entry.generatedAtMs === ms) ?? null;
}

async function handleList(pipeline, okHeaders, errorHeaders) {
  const results = await pipeline([['ZRANGE', HISTORY_KEY, String(-MAX_LIST_ENTRIES), '-1']]);
  if (!results || pipelineEntryFailed(results[0])) {
    return jsonResponse({ error: 'History store unavailable' }, 503, errorHeaders);
  }
  const members = Array.isArray(results[0].result) ? results[0].result : [];
  const entries = members
    .map(parseMember)
    .filter((snapshot) => snapshot && typeof snapshot.generatedAt === 'string')
    .map((snapshot) => ({
      generatedAt: snapshot.generatedAt,
      clusterCount: Number.isFinite(snapshot.clusterCount) ? snapshot.clusterCount : null,
      headline: headlineFromBrief(snapshot.worldBrief),
    }))
    .reverse(); // ZRANGE is oldest-first; the API contract is newest-first
  return jsonResponse({ entries }, 200, okHeaders);
}

async function handleSnapshot(at, pipeline, okHeaders, errorHeaders) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) {
    return jsonResponse({ error: 'Invalid "at" parameter: expected a generatedAt timestamp' }, 400, errorHeaders);
  }
  const results = await pipeline([['ZRANGEBYSCORE', HISTORY_KEY, String(ms), String(ms)]]);
  if (!results || pipelineEntryFailed(results[0])) {
    return jsonResponse({ error: 'History store unavailable' }, 503, errorHeaders);
  }
  const members = Array.isArray(results[0].result) ? results[0].result : [];
  const snapshot = members.length > 0 ? parseMember(members[0]) : null;
  if (!snapshot) {
    return jsonResponse({ error: 'Snapshot not found' }, 404, errorHeaders);
  }
  return jsonResponse(snapshot, 200, okHeaders);
}

async function handleDiff(diffParam, pipeline, okHeaders, errorHeaders) {
  const parts = diffParam.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return jsonResponse({ error: 'Invalid "diff" parameter: expected "<generatedAtA>,<generatedAtB>"' }, 400, errorHeaders);
  }
  const entries = await loadArchive(pipeline);
  if (entries === null) {
    return jsonResponse({ error: 'History store unavailable' }, 503, errorHeaders);
  }
  const resolved = parts.map((selector) => resolveSelector(selector, entries));
  const badIndex = resolved.findIndex((entry) => entry === undefined);
  if (badIndex >= 0) {
    return jsonResponse({ error: `Invalid diff selector: "${parts[badIndex]}"` }, 400, errorHeaders);
  }
  const missingIndex = resolved.findIndex((entry) => entry === null);
  if (missingIndex >= 0) {
    return jsonResponse({ error: `No archived snapshot for diff selector: "${parts[missingIndex]}"` }, 404, errorHeaders);
  }
  return jsonResponse(diffBriefSnapshots(resolved[0].snapshot, resolved[1].snapshot), 200, okHeaders);
}

export default async function handler(req) {
  const cors = getPublicCorsHeaders('GET, OPTIONS');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const okHeaders = { ...cors, 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };
  const errorHeaders = { ...cors, 'Cache-Control': 'no-store' };
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, errorHeaders);
  }

  let params;
  try {
    params = new URL(req.url).searchParams;
  } catch {
    return jsonResponse({ error: 'Bad request' }, 400, errorHeaders);
  }

  const at = params.get('at');
  const diff = params.get('diff');
  if (at !== null && diff !== null) {
    return jsonResponse({ error: 'Pass either "at" or "diff", not both' }, 400, errorHeaders);
  }

  try {
    if (diff !== null) return await handleDiff(diff, redisPipeline, okHeaders, errorHeaders);
    if (at !== null) return await handleSnapshot(at, redisPipeline, okHeaders, errorHeaders);
    return await handleList(redisPipeline, okHeaders, errorHeaders);
  } catch (error) {
    console.error('[brief-history] failed', error);
    return jsonResponse({ error: 'History store unavailable' }, 503, errorHeaders);
  }
}
