// PII redaction, call scoring and transcript stats. The LLM call is passed in
// (Scriberr's llm()), so everything here can be tested with a fake.

export const CATEGORIES = ['intro', 'retention', 'info', 'sentiment', 'objection', 'control'];
export const TOPICS = ['Refinance', 'Purchase', 'HELOC', 'Rate shopping', 'Closing costs', 'Document status', 'Payment / escrow', 'Credit', 'Complaint', 'Other'];

const REDACT_CHUNK_LINES = 40;
const REDACT_CHUNK_CHARS = 12000;
const MAX_ANALYSIS_TRANSCRIPT_CHARS = parseInt(process.env.ANALYSIS_MAX_TRANSCRIPT_CHARS || '60000', 10);

export const mmss = ms => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const m = /^\s*(?:(\d+):)?(\d+):(\d{1,2})\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

// Every complete top-level {...} object in the text, in order, found by matching braces
// outside strings. An unbalanced object at the end is included as-is (JSON.parse reports it).
function jsonObjects(text) {
  const found = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') { if (depth > 0) inString = true; }
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) found.push(text.slice(start, i + 1));
  }
  if (depth > 0) found.push(text.slice(start));
  return found;
}

function parseLoose(candidate) {
  try {
    return JSON.parse(candidate);
  } catch (err) {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      throw err;
    }
  }
}

// Pulls a JSON object out of a model reply, which may wrap it in prose or ``` fences, add text
// after it, or write other small objects first. Returns the first object `isWanted` accepts,
// else the first one that parses. Trailing commas are forgiven; anything else still throws.
export function extractJson(text, isWanted = () => true) {
  const candidates = jsonObjects(String(text).replace(/```(?:json)?/gi, ''));
  if (!candidates.length) throw new Error('Reply contained no JSON object');
  let firstParsed;
  let firstError;
  for (const candidate of candidates) {
    try {
      const obj = parseLoose(candidate);
      if (isWanted(obj)) return obj;
      if (firstParsed === undefined) firstParsed = obj;
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  if (firstParsed !== undefined) return firstParsed;
  throw firstError;
}

// ------------------------------------------------------------------
// PII redaction
// ------------------------------------------------------------------
// Lines go to the model and come back as "<number>|<text>" rather than JSON: nothing in what
// people say (quotes, commas, braces) needs escaping, so the reply can't be malformed that way.
const REDACT_PROMPT = `You redact personal information from a mortgage company phone call transcript.
Replace each piece of personal information with a tag in square brackets:
[PERSON_NAME] for any person's full or last name (keep the agent's and customer's first names only if they are used alone),
[SSN], [DATE_OF_BIRTH], [ACCOUNT_NUMBER] (loan, bank, routing, account numbers), [CARD_NUMBER], [CARD_CVV], [CARD_EXPIRATION],
[PHONE_NUMBER], [EMAIL_ADDRESS], [ADDRESS] (street addresses, unit numbers, zip codes), [DRIVERS_LICENSE], [PASSPORT_NUMBER], [PASSWORD].
Numbers spoken as words or digit by digit are still personal information.
Do not change anything else: keep loan amounts, interest rates, dates of appointments, company names and all other words exactly as they are.
Keep any existing [TAG] placeholders.
Each input line is "<number>|<text>". Reply with exactly one line for every input line, in the same order and the same form, "<number>|<redacted text>", using the same numbers. Write nothing else: no JSON, no notes.

Lines:
`;

const oneLine = text => String(text).replace(/\s*[\r\n]+\s*/g, ' ').trim();

function chunkUtterances(utterances) {
  const chunks = [];
  let current = [];
  let chars = 0;
  utterances.forEach((u, i) => {
    if (!oneLine(u.text)) return; // nothing to redact
    if (current.length && (current.length >= REDACT_CHUNK_LINES || chars + u.text.length > REDACT_CHUNK_CHARS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(i);
    chars += u.text.length;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

// Reads a "<number>|<text>" reply. Returns { lines: Map(index -> text), missing: [indexes] }.
// Chatter and fences are ignored. A number that wasn't asked for, or the same number twice
// with different text, means the numbering can't be trusted, so the whole reply is rejected.
export function parseRedaction(reply, indexes) {
  const wanted = new Set(indexes);
  const lines = new Map();
  let trusted = true;
  for (const raw of String(reply).split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s*)?(\d+)\s*\|(.*)$/.exec(raw);
    if (!m) continue;
    const i = Number(m[1]);
    const text = m[2].trim();
    if (!wanted.has(i) || (lines.has(i) && lines.get(i) !== text)) { trusted = false; break; }
    lines.set(i, text);
  }
  if (!trusted) return { lines: new Map(), missing: [...indexes] };
  for (const [i, text] of lines) if (!text) lines.delete(i);
  return { lines, missing: indexes.filter(i => !lines.has(i)) };
}

// Redacts the given lines: one request, then one retry for just the lines that didn't come
// back, then halves of whatever is still missing, down to single lines. Throws if a single
// line can't be redacted.
async function redactLines(utterances, indexes, llm) {
  const ask = async idx => parseRedaction(await llm(REDACT_PROMPT + idx.map(i => `${i}|${oneLine(utterances[i].text)}`).join('\n')), idx);
  const done = new Map();
  let { lines, missing } = await ask(indexes);
  lines.forEach((text, i) => done.set(i, text));
  if (missing.length) {
    ({ lines, missing } = await ask(missing));
    lines.forEach((text, i) => done.set(i, text));
  }
  if (missing.length === 1) throw new Error(`Redaction reply is missing line ${missing[0]}`);
  if (missing.length) {
    const mid = Math.ceil(missing.length / 2);
    for (const half of [missing.slice(0, mid), missing.slice(mid)]) {
      (await redactLines(utterances, half, llm)).forEach((text, i) => done.set(i, text));
    }
  }
  return done;
}

// Returns a redacted copy of the utterances. Timings and speakers come from the input,
// never from the model. Throws if any line can't be redacted, so nothing unredacted is kept.
export async function redactUtterances(utterances, llm) {
  const redacted = utterances.map(u => ({ ...u }));
  for (const indexes of chunkUtterances(utterances)) {
    const byIndex = await redactLines(utterances, indexes, llm);
    for (const i of indexes) redacted[i].text = byIndex.get(i);
  }
  return redacted;
}

// ------------------------------------------------------------------
// Transcript stats (no LLM)
// ------------------------------------------------------------------
const wordCount = text => (text.match(/\S+/g) || []).length;

// agentSpeaker may be null when it isn't known yet; agent-specific fields are then null.
export function computeTranscriptStats(utterances, agentSpeaker = null) {
  const sorted = [...utterances].sort((a, b) => a.start - b.start);
  const talkMs = {};
  const words = {};
  let interruptions = {};
  let deadAirMs = 0;
  let longestSilenceMs = 0;
  let longestMonologueMs = 0;
  let longestMonologueSpeaker = null;
  let coveredUntil = sorted.length ? sorted[0].start : 0;

  sorted.forEach((u, idx) => {
    const dur = Math.max(0, u.end - u.start);
    talkMs[u.speaker] = (talkMs[u.speaker] || 0) + dur;
    words[u.speaker] = (words[u.speaker] || 0) + wordCount(u.text);
    if (dur > longestMonologueMs) {
      longestMonologueMs = dur;
      longestMonologueSpeaker = u.speaker;
    }
    if (idx > 0) {
      const gap = u.start - coveredUntil;
      if (gap > 0) {
        // Pauses under 2s are normal turn-taking, not dead air.
        if (gap >= 2000) deadAirMs += gap;
        longestSilenceMs = Math.max(longestSilenceMs, gap);
      } else if (gap < 0 && sorted[idx - 1].speaker !== u.speaker) {
        // Started speaking before the other speaker finished.
        interruptions[u.speaker] = (interruptions[u.speaker] || 0) + 1;
      }
    }
    coveredUntil = Math.max(coveredUntil, u.end);
  });

  const callMs = sorted.length ? coveredUntil - sorted[0].start : 0;
  const totalTalk = Object.values(talkMs).reduce((a, b) => a + b, 0) || 1;
  const share = {};
  const wpm = {};
  for (const speaker of Object.keys(talkMs)) {
    share[speaker] = Math.round((talkMs[speaker] / totalTalk) * 100);
    wpm[speaker] = talkMs[speaker] ? Math.round(words[speaker] / (talkMs[speaker] / 60000)) : 0;
  }
  const customer = agentSpeaker ? Object.keys(talkMs).find(s => s !== agentSpeaker) || null : null;
  return {
    callMs,
    turns: sorted.length,
    talkShare: share,
    wordsPerMinute: wpm,
    interruptions,
    deadAirMs,
    longestSilenceMs,
    longestMonologueMs,
    longestMonologueSpeaker,
    agentSpeaker,
    agentTalkShare: agentSpeaker ? share[agentSpeaker] ?? 0 : null,
    customerTalkShare: customer ? share[customer] ?? 0 : null,
    silenceShare: callMs ? Math.max(0, Math.round(((callMs - Math.min(callMs, totalTalk)) / callMs) * 100)) : 0,
    agentWpm: agentSpeaker ? wpm[agentSpeaker] ?? 0 : null,
    agentInterruptions: agentSpeaker ? interruptions[agentSpeaker] || 0 : null
  };
}

// ------------------------------------------------------------------
// Which speaker is the agent
// ------------------------------------------------------------------
const SPEAKER_CHECK_CHARS = 8000;
const SPEAKER_PROMPT = `This is the start of a phone call recorded by a mortgage company. Speakers are labelled by diarization ("Speaker A", "Speaker B"). One speaker is the company's AGENT (loan officer or processor); the other is the CUSTOMER.

The agent is the one selling a mortgage or helping the other person get one: offering rates, loan programs or quotes, asking qualifying questions (income, credit, property value, loan balance, occupancy, timeline), explaining next steps, and steering toward an application, documents or an appointment.
The customer is the one seeking the loan or answering those questions about their own finances and home.

Either speaker may talk first: on inbound calls the customer often speaks first, and the recording can start mid-greeting. Decide from what each speaker says, not from who speaks first.

Reply with only JSON: {"agent_speaker":"A","confidence":"high","reason":"one short sentence"}
agent_speaker is the letter of the agent's label, or "unknown" if you cannot tell. confidence is "high", "medium" or "low".`;

export function buildSpeakerPrompt(utterances) {
  let transcript = utterances.map(u => `Speaker ${u.speaker}: ${u.text}`).join('\n');
  if (transcript.length > SPEAKER_CHECK_CHARS) transcript = `${transcript.slice(0, SPEAKER_CHECK_CHARS)}\n[transcript continues]`;
  return `${SPEAKER_PROMPT}\n\nTranscript:\n${transcript}`;
}

// Returns the agent's speaker letter, or null when the model can't tell with at least
// medium confidence. Throws only if the LLM request itself fails.
export async function identifyAgentSpeaker(utterances, llm) {
  const speakers = new Set(utterances.map(u => u.speaker));
  if (speakers.size < 2) return null;
  const reply = await llm(buildSpeakerPrompt(utterances), { schema: 'speaker' });
  let json;
  try { json = extractJson(reply); } catch { return null; }
  const letter = String(json.agent_speaker || '').trim().toUpperCase();
  const confidence = String(json.confidence || '').trim().toLowerCase();
  if (!speakers.has(letter) || !['high', 'medium'].includes(confidence)) return null;
  return letter;
}

// ------------------------------------------------------------------
// Call analysis (summary + scores in one request)
// ------------------------------------------------------------------
const RUBRIC = `You review phone calls for a mortgage company's quality team. Speakers are labelled by diarization ("Speaker A", "Speaker B"); one is the company's agent (loan officer or processor) and one is the customer. Personal information has been replaced with placeholders like [PHONE_NUMBER]; keep them as-is and never guess what they contain.

Score the AGENT's performance from -10 (worst) to +10 (best) in each category. 0 means average or mixed.
- intro (Introduction): +10 = greets warmly, gives full name and company, NMLS ID if applicable, recording disclosure, asks the customer's name, states the purpose. -10 = no name, no company, no disclosure, rude or abrupt opening.
- retention (Client retention): +10 = keeps the customer engaged, builds trust, sets a concrete next step (appointment, application, documents). -10 = customer leaves unhappy or goes elsewhere and the agent makes no attempt to keep them.
- info (Information gathered): +10 = collects the details needed (purpose, occupancy, balance, rate, income, credit, timeline, contact preference) before advising. -10 = asks nothing useful or gives advice blind.
- sentiment (Average client sentiment): the customer's mood across the whole call. +10 = consistently positive, grateful. -10 = angry or distressed throughout.
- objection (Objection handling): only if the customer raised a concern, doubt or pushback. +10 = acknowledges it, answers it with facts, confirms it is resolved. -10 = ignores, dismisses or argues. If there was no objection, set "present": false and "score": 0.
- control (Call control & professionalism): +10 = leads the call with clear questions, polite and professional language, good hold etiquette, little dead air, no talking over the customer. -10 = rambling, unprofessional language, long dead air, constant interrupting. Use the measured stats below as evidence.

For each category give a one-sentence reason and a short exact quote from the transcript with its timestamp.
`;

const ANALYSIS_PROMPT = `${RUBRIC}
Also give:
- agent_speaker: the letter of the agent's speaker label
- summary: 3-6 short bullet points (purpose, key details, outcome, next steps)
- call_reason and outcome: one short phrase each
- topics: 1-3 values chosen ONLY from this list: ${TOPICS.join(', ')}
- keywords: up to 5 short lowercase phrases that characterise the call (e.g. "rate lock", "break-even")
- key_moments: up to 6 {"at":"m:ss","label":"..."}
- objections: [{"at":"m:ss","text":"...","handled":true|false}]
- action_items: short strings
- sentiment_timeline: about 8-10 points spread across the call, {"at":"m:ss","score":-1.0..1.0} for the customer's sentiment
- coaching_tips: 2-3 short, specific tips for the agent

Reply with only JSON in this exact shape:
{"agent_speaker":"A","summary":["..."],"call_reason":"...","outcome":"...",
"scores":{"intro":{"score":0,"reason":"...","quote":"...","at":"0:00"},"retention":{...},"info":{...},"sentiment":{...},"objection":{"present":true,"score":0,"reason":"...","quote":"...","at":"0:00"},"control":{...}},
"topics":["..."],"keywords":["..."],"key_moments":[],"objections":[],"action_items":[],"sentiment_timeline":[],"coaching_tips":[]}
`;

// Retry used when a reply had everything but the scores: ask for the scores alone.
const SCORES_ONLY_PROMPT = `${RUBRIC}
Reply with only JSON in this exact shape and nothing else (no summary or other fields):
{"agent_speaker":"A","scores":{"intro":{"score":0,"reason":"...","quote":"...","at":"0:00"},"retention":{"score":0,"reason":"...","quote":"...","at":"0:00"},"info":{"score":0,"reason":"...","quote":"...","at":"0:00"},"sentiment":{"score":0,"reason":"...","quote":"...","at":"0:00"},"objection":{"present":false,"score":0,"reason":"...","quote":"...","at":"0:00"},"control":{"score":0,"reason":"...","quote":"...","at":"0:00"}}}
`;

export function buildAnalysisPrompt(utterances, agentSpeaker = null, base = ANALYSIS_PROMPT) {
  const stats = computeTranscriptStats(utterances);
  let transcript = utterances.map(u => `[${mmss(u.start)}] Speaker ${u.speaker}: ${u.text}`).join('\n');
  if (transcript.length > MAX_ANALYSIS_TRANSCRIPT_CHARS) {
    transcript = `${transcript.slice(0, MAX_ANALYSIS_TRANSCRIPT_CHARS)}\n[transcript truncated]`;
  }
  const measured = [
    `Call length ${mmss(stats.callMs)}, ${stats.turns} turns`,
    `Talk share by speaker: ${Object.entries(stats.talkShare).map(([s, p]) => `${s} ${p}%`).join(', ')}`,
    `Words per minute: ${Object.entries(stats.wordsPerMinute).map(([s, w]) => `${s} ${w}`).join(', ')}`,
    `Interruptions (started before the other finished): ${Object.entries(stats.interruptions).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}`,
    `Dead air (pauses of 2s or more): ${mmss(stats.deadAirMs)} total, longest silence ${mmss(stats.longestSilenceMs)}`
  ].join('\n');
  const customers = [...new Set(utterances.map(u => u.speaker))].filter(sp => sp !== agentSpeaker);
  const roles = agentSpeaker
    ? `\nSpeaker ${agentSpeaker} is the agent and ${customers.map(sp => `Speaker ${sp}`).join(' and ')} is the customer. Score Speaker ${agentSpeaker} and set agent_speaker to "${agentSpeaker}".\n`
    : '';
  return `${base}${roles}\nMeasured stats:\n${measured}\n\nTranscript:\n${transcript}`;
}

const clampScore = value => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) throw new Error(`Score is not a number: ${value}`);
  return Math.max(-10, Math.min(10, n));
};
const str = (value, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const strList = (value, maxItems, maxLen = 300) => (Array.isArray(value) ? value.map(v => str(v, maxLen)).filter(Boolean).slice(0, maxItems) : []);

// Validates and normalises the model's JSON. Scores are clamped to -10..10 and the
// overall score is computed here as the plain average of the categories that apply.
const lowerKeys = obj => (obj ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.trim().toLowerCase(), v])) : null);
// Names models use for each category, compared with case, spaces and punctuation removed.
const CATEGORY_ALIASES = {
  intro: ['intro', 'introduction', 'opening'],
  retention: ['retention', 'clientretention', 'customerretention'],
  info: ['info', 'information', 'informationgathered', 'infogathered'],
  sentiment: ['sentiment', 'clientsentiment', 'averageclientsentiment', 'customersentiment'],
  objection: ['objection', 'objectionhandling', 'objections'],
  control: ['control', 'callcontrol', 'professionalism', 'callcontrolprofessionalism', 'callcontrolandprofessionalism']
};
const ALIAS_TO_CATEGORY = new Map(Object.entries(CATEGORY_ALIASES).flatMap(([key, names]) => names.map(n => [n, key])));
const normKey = k => String(k).toLowerCase().replace(/[^a-z]/g, '');
const isPlainObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isScoreValue = v => isPlainObject(v) || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

// The categories an object holds directly, as { intro: value, ... }, or null unless all five
// non-objection categories are there (objection is optional).
function categoriesIn(obj) {
  if (!isPlainObject(obj)) return null;
  const found = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = ALIAS_TO_CATEGORY.get(normKey(k));
    if (key && !(key in found) && isScoreValue(v)) found[key] = v;
  }
  return CATEGORIES.every(k => k === 'objection' || k in found) ? found : null;
}

// Finds the scores in a reply: the "scores" object, then the top level, then any nested
// object (e.g. "ratings", "category_scores"). Null if there are none.
export function findScores(json, depth = 0) {
  if (!isPlainObject(json) || depth > 3) return null;
  const scoresKey = Object.keys(json).find(k => normKey(k) === 'scores');
  const fromScores = scoresKey ? categoriesIn(json[scoresKey]) : null;
  if (fromScores) return fromScores;
  const top = categoriesIn(json);
  if (top) return top;
  for (const value of Object.values(json)) {
    const nested = findScores(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

const looksLikeAnalysis = obj => findScores(obj) !== null;

// detectedSpeaker (from identifyAgentSpeaker) wins over the scoring reply's agent_speaker.
export function validateAnalysis(rawJson, utterances, detectedSpeaker = null) {
  const json = lowerKeys(rawJson) || {};
  const speakers = new Set(utterances.map(u => u.speaker));
  const replied = String(json.agent_speaker || '').trim().toUpperCase();
  let agentSpeaker, agentSpeakerSource;
  if (detectedSpeaker && speakers.has(detectedSpeaker)) [agentSpeaker, agentSpeakerSource] = [detectedSpeaker, 'detected'];
  else if (speakers.has(replied)) [agentSpeaker, agentSpeakerSource] = [replied, 'scoring'];
  else [agentSpeaker, agentSpeakerSource] = [utterances[0]?.speaker || null, 'first_speaker']; // the agent usually speaks first on a recorded line

  // Models name and nest the scores in different ways; findScores accepts the common ones.
  const scoreSource = findScores(rawJson);
  if (!scoreSource) throw new Error('Analysis has no "scores" object');
  const scores = {};
  const categories = {};
  for (const key of CATEGORIES) {
    // A plain number is a score with no reason; a missing objection means there was none.
    const value = scoreSource[key];
    const raw = isPlainObject(value) ? lowerKeys(value) : value === undefined ? { present: false, score: 0 } : { score: value };
    const present = key === 'objection' ? raw.present !== false : true;
    scores[key] = present ? clampScore(raw.score) : null;
    categories[key] = {
      score: scores[key],
      reason: str(raw.reason),
      quote: str(raw.quote, 300),
      atMs: parseTimestamp(raw.at),
      ...(key === 'objection' ? { present } : {})
    };
  }
  const applicable = CATEGORIES.map(k => scores[k]).filter(v => v !== null);
  const overall = Math.round((applicable.reduce((a, b) => a + b, 0) / applicable.length) * 10) / 10;

  const timed = (list, max, fields) => (Array.isArray(list) ? list : [])
    .map(item => ({ atMs: parseTimestamp(item?.at), ...fields(item || {}) }))
    .filter(item => item.atMs !== null)
    .slice(0, max);

  const summaryList = Array.isArray(json.summary) ? strList(json.summary, 8) : strList([json.summary], 1, 2000);
  const allowedTopics = new Map(TOPICS.map(t => [t.toLowerCase(), t]));
  const topics = [...new Set(strList(json.topics, 3).map(t => allowedTopics.get(t.toLowerCase())).filter(Boolean))];

  return {
    overall,
    scores,
    summary: summaryList.length ? summaryList.map(s => `- ${s.replace(/^[-•*]\s*/, '')}`).join('\n') : null,
    topics: topics.length ? topics : ['Other'],
    keywords: [...new Set(strList(json.keywords, 5, 60).map(k => k.toLowerCase()))],
    agentSpeaker,
    analysis: {
      agentSpeaker,
      agentSpeakerSource,
      callReason: str(json.call_reason, 200),
      outcome: str(json.outcome, 200),
      categories,
      keyMoments: timed(json.key_moments, 6, m => ({ label: str(m.label, 120) })).filter(m => m.label),
      objections: timed(json.objections, 10, o => ({ text: str(o.text, 300), handled: Boolean(o.handled) })).filter(o => o.text),
      actionItems: strList(json.action_items, 10),
      sentimentTimeline: timed(json.sentiment_timeline, 12, p => ({ score: Math.max(-1, Math.min(1, Number(p.score) || 0)) })),
      coachingTips: strList(json.coaching_tips, 3)
    }
  };
}

// Runs the analysis request, retrying once if the reply can't be parsed or validated.
// First asks which speaker is the agent; if that can't be decided, the scoring reply
// (or the first speaker) decides as before.
export async function analyzeCall(utterances, llm) {
  let detected = null;
  try {
    detected = await identifyAgentSpeaker(utterances, llm);
  } catch (err) {
    console.warn(`⚠️ [ANALYZE] Speaker check failed, using the scoring reply: ${err.message}`);
  }
  const prompt = buildAnalysisPrompt(utterances, detected);
  // Enough of the reply to see what the model sent: start, end, length and the JSON's keys.
  const logUnusable = (err, reply, json) => {
    const text = String(reply);
    const keys = isPlainObject(json) ? ` keys=[${Object.keys(json).join(', ')}]` : '';
    console.warn(`⚠️ [ANALYZE] Unusable scoring reply (${err.message}) length=${text.length}${keys} start=${JSON.stringify(text.slice(0, 400))} end=${JSON.stringify(text.slice(-300))}`);
  };
  const parse = reply => {
    try { return extractJson(reply, looksLikeAnalysis); } catch (err) { logUnusable(err, reply, null); return null; }
  };
  const finish = result => ({ ...result, stats: computeTranscriptStats(utterances, result.agentSpeaker) });

  const firstReply = await llm(prompt, { schema: 'analysis' });
  const first = parse(firstReply);
  if (first) {
    try { return finish(validateAnalysis(first, utterances, detected)); } catch (err) { logUnusable(err, firstReply, first); }
  }
  // A reply with everything but the scores gets a short scores-only follow-up, merged with
  // the first reply's summary and other fields; an unreadable one is simply asked again.
  const secondReply = first
    ? await llm(buildAnalysisPrompt(utterances, detected, SCORES_ONLY_PROMPT), { schema: 'scores' })
    : await llm(prompt, { schema: 'analysis' });
  const second = parse(secondReply);
  if (!second) throw new Error('Reply contained no usable JSON');
  const merged = first ? { ...first, agent_speaker: second.agent_speaker ?? first.agent_speaker, scores: second } : second;
  try {
    return finish(validateAnalysis(merged, utterances, detected));
  } catch (err) {
    logUnusable(err, secondReply, second);
    throw err;
  }
}
