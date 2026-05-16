import { NextResponse } from "next/server"
import { promises as fs } from "fs"
import path from "path"
import type { MissingWordConfidence, MissingWordReplacement } from "@/lib/types"

export const runtime = "nodejs"

type ResolveMissingWordsBody = {
  sentence?: unknown
  missingWords?: unknown
  dictionaryWords?: unknown
}

type ModelDecision = {
  originalWord?: unknown
  type?: unknown
  candidates?: unknown
  resolvedWord?: unknown
  replacementWord?: unknown
  confidence?: unknown
  reason?: unknown
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
        inlineData?: unknown
      }>
    }
  }>
  text?: string
  response?: {
    text?: unknown
  }
}

type ResolveMissingWordsInput = {
  sentence: string
  missingWords: string[]
}

const GEMINI_MODEL = "gemini-2.5-flash"
const SYNONYM_MAP_PATH = path.join(process.cwd(), "public", "data", "synonymMap.json")
const MANUAL_SYNONYM_MAP_PATH = path.join(process.cwd(), "public", "data", "manualSynonymMap.json")
const CONFIDENCES = new Set<MissingWordConfidence>(["low", "medium", "high"])
const DEBUG_RESOLVER = process.env.DEBUG_RESOLVER === "true"
const COMMON_REPLACEMENT_CANDIDATES: Record<string, string[]> = {
  hey: ["hello"],
  hi: ["hello"],
  heyy: ["hello"],
  "hello there": ["hello"],
  thanks: ["thank you", "thank"],
  thanx: ["thank you"],
  thx: ["thank you"],
  thankyou: ["thank you"],
  exhausting: ["tired", "hard", "difficult"],
  exhausted: ["tired"],
  tiring: ["tired"],
  accessibility: ["access", "able", "help"],
  accessible: ["access", "able"],
  frustration: ["upset", "angry", "mad", "sad", "annoyed", "tired"],
  frustrating: ["upset", "angry", "mad", "sad", "annoyed", "tired"],
  frustrated: ["upset", "angry", "mad", "sad", "annoyed", "tired"],
}
const WORD_FORM_CANDIDATES: Record<string, string[]> = {
  did: ["happen", "finish"],
  came: ["come"],
  coming: ["come"],
  comes: ["come"],
  went: ["go"],
  gone: ["go"],
  goes: ["go"],
  ran: ["run"],
  running: ["run"],
  eating: ["eat"],
  ate: ["eat"],
  bought: ["buy"],
  purchased: ["buy"],
  purchasing: ["buy"],
  frustration: ["upset"],
  frustrating: ["upset"],
  frustrated: ["upset"],
}
const LOCAL_CONCEPT_CANDIDATES: Record<string, string[]> = {
  ...COMMON_REPLACEMENT_CANDIDATES,
  fallback: ["help", "support", "use", "backup", "alternate"],
}
const GENERIC_HELPER_WORDS = new Set(["do", "did", "does", "done"])
const WEAK_GENERIC_HELPER_CANDIDATES = new Set(["act", "perform", "make", "create", "accomplish", "complete", "work"])

function resolverLog(message: string, data?: unknown) {
  if (!DEBUG_RESOLVER) return
  if (data === undefined) {
    console.log(`[resolver] ${message}`)
    return
  }
  console.log(`[resolver] ${message}`, data)
}

function normalizeWord(value: string) {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s']/g, " ")
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function allowsDidToMake(sentence: string) {
  return /\b(make|made|create|created|build|built|produce|produced|craft|crafted)\b/i.test(sentence)
}

function allowsGenericActionCandidate(sentence: string) {
  return /\b(make|made|making|create|created|creating|build|built|building|perform|performed|performing|act|acted|acting|accomplish|accomplished)\b/i.test(sentence)
}

function validateBody(body: ResolveMissingWordsBody) {
  const sentence = typeof body.sentence === "string" ? body.sentence : ""
  const missingWords = Array.isArray(body.missingWords)
    ? body.missingWords.filter((word): word is string => typeof word === "string" && Boolean(word.trim()))
    : []
  const dictionaryWords = Array.isArray(body.dictionaryWords)
    ? body.dictionaryWords.filter((word): word is string => typeof word === "string" && Boolean(word.trim()))
    : []

  return {
    sentence,
    missingWords: Array.from(new Set(missingWords)),
    dictionaryWords: Array.from(new Set(dictionaryWords)),
  }
}

function emptyResponse(missingWords: string[], error?: string) {
  resolverLog("final resolution type: fingerspell")
  resolverLog("fingerspell reason: resolver API missing sentence, missing words, or dictionary words")
  return NextResponse.json({
    replacements: [],
    unresolved: missingWords,
    ...(error ? { error } : {}),
  })
}

function extractJsonText(content: string) {
  const trimmed = content.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
  const firstBrace = unfenced.indexOf("{")
  const lastBrace = unfenced.lastIndexOf("}")

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return unfenced
  }

  return unfenced.slice(firstBrace, lastBrace + 1)
}

function parseModelJson(content: string): { parsed: { decisions?: ModelDecision[]; replacements?: ModelDecision[] }; jsonText: string; error?: string } {
  const jsonText = extractJsonText(content)

  try {
    return { parsed: JSON.parse(jsonText), jsonText }
  } catch (error) {
    return {
      parsed: {},
      jsonText,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function getGeminiRawText(data: GeminiResponse) {
  const responseText = typeof data.response?.text === "function"
    ? undefined
    : typeof data.response?.text === "string"
      ? data.response.text
      : undefined
  const directText = typeof data.text === "string" ? data.text : undefined
  const candidateText = data.candidates
    ?.flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("")

  return (directText || responseText || candidateText || "").trim()
}

function looksUnsafeToLearn(rawWord: string, normalizedWord: string) {
  if (normalizedWord.length < 4) return true
  if (/\d/.test(rawWord)) return true
  if (/@|https?:\/\/|www\.|[._/\\]/i.test(rawWord)) return true
  if (!/^[a-z\s]+$/.test(normalizedWord)) return true
  return false
}

async function readSynonymMapFile(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8")
  const parsed = JSON.parse(raw) as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([word, mappedWord]) => [normalizeWord(word), normalizeWord(mappedWord)]),
  )
}

async function readSynonymMap() {
  try {
    const synonymMap = await readSynonymMapFile(SYNONYM_MAP_PATH)
    console.log(`[resolve-missing-words] synonym file path loaded: ${SYNONYM_MAP_PATH}`)
    console.log(`[resolve-missing-words] synonymEntryCount loaded: ${Object.keys(synonymMap).length}`)
    resolverLog(`synonymMap loaded: true (${Object.keys(synonymMap).length} entries)`)
    return synonymMap
  } catch (error) {
    console.warn(
      `[resolve-missing-words] generated synonym map unavailable at ${SYNONYM_MAP_PATH}; trying manual fallback.`,
      error,
    )
    try {
      const synonymMap = await readSynonymMapFile(MANUAL_SYNONYM_MAP_PATH)
      console.log(`[resolve-missing-words] synonym file path loaded: ${MANUAL_SYNONYM_MAP_PATH}`)
      console.log(`[resolve-missing-words] synonymEntryCount loaded: ${Object.keys(synonymMap).length}`)
      resolverLog(`synonymMap loaded: true (${Object.keys(synonymMap).length} manual entries)`)
      return synonymMap
    } catch (manualError) {
      console.warn(
        `[resolve-missing-words] manual synonym map unavailable at ${MANUAL_SYNONYM_MAP_PATH}; continuing without synonyms.`,
        manualError,
      )
      resolverLog("synonymMap loaded: false")
      return {}
    }
  }
}

async function addSynonymMapping(
  originalWord: string,
  resolvedWord: string,
  dictionaryWords: string[],
  confidence: MissingWordConfidence,
) {
  const normalizedOriginal = normalizeWord(originalWord)
  const normalizedResolved = normalizeWord(resolvedWord)
  const dictionaryLookup = new Map(dictionaryWords.map((word) => [normalizeWord(word), word]))
  const canonicalResolved = dictionaryLookup.get(normalizedResolved)

  if (confidence === "low") return false
  if (!canonicalResolved) return false
  if (looksUnsafeToLearn(originalWord, normalizedOriginal)) return false

  const synonymMap = await readSynonymMap()
  const existing = synonymMap[normalizedOriginal]
  if (existing) {
    if (existing !== normalizeWord(canonicalResolved)) {
      console.log(`[resolver] learned synonym skipped; existing mapping differs: ${normalizedOriginal} -> ${existing}`)
    }
    return existing === normalizeWord(canonicalResolved)
  }

  synonymMap[normalizedOriginal] = canonicalResolved
  const sorted = Object.fromEntries(Object.entries(synonymMap).sort(([a], [b]) => a.localeCompare(b)))

  await fs.mkdir(path.dirname(SYNONYM_MAP_PATH), { recursive: true })
  await fs.writeFile(SYNONYM_MAP_PATH, `${JSON.stringify(sorted, null, 2)}\n`, "utf8")
  console.log(`[resolve-missing-words] Saved learned synonym: ${normalizedOriginal} -> ${canonicalResolved}`)
  console.log(`[resolver] saved learned synonym: ${normalizedOriginal} → ${canonicalResolved}`)
  return true
}

function validateModelDecisions(
  decisions: ModelDecision[] | undefined,
  missingWords: string[],
  dictionaryWords: string[],
  synonymMap: Record<string, string>,
  sentence: string,
) {
  const missingSet = new Set(missingWords)
  const dictionarySet = new Set(dictionaryWords)
  const dictionaryLookup = new Map(dictionaryWords.map((word) => [normalizeWord(word), word]))
  const replacementsByOriginal = new Map<string, MissingWordReplacement>()
  const fingerspellWords = new Set<string>()
  const fingerspellReasons = new Map<string, string>()
  const invalidDictionaryWords = new Map<string, string>()

  ;(decisions || []).forEach((decision) => {
    const originalRaw = typeof decision.originalWord === "string" ? decision.originalWord : ""
    const originalWord = normalizeWord(originalRaw)
    const decisionType = typeof decision.type === "string" ? decision.type : "concept_candidates"
    const candidates = Array.isArray(decision.candidates)
      ? decision.candidates.filter((candidate): candidate is string => typeof candidate === "string").slice(0, 10)
      : [
          typeof decision.resolvedWord === "string" ? decision.resolvedWord : "",
          typeof decision.replacementWord === "string" ? decision.replacementWord : "",
        ].filter(Boolean)

    if (!originalWord || !missingSet.has(originalWord)) return

    if (decisionType === "fingerspell") {
      fingerspellWords.add(originalWord)
      fingerspellReasons.set(originalWord, typeof decision.reason === "string" ? decision.reason : "proper noun or no safe semantic equivalent")
      console.log(`[resolve-missing-words] AI decided fingerspelling: ${originalWord}`)
      console.log(`[resolve-missing-words] rejection reason: AI chose fingerspell`)
      resolverLog(`final resolution type: fingerspell`)
      resolverLog(`fingerspell reason: ${originalWord}: proper noun or no safe semantic equivalent`)
      return
    }

    if (decisionType !== "concept_candidates" && decisionType !== "semantic_match") {
      fingerspellWords.add(originalWord)
      fingerspellReasons.set(originalWord, "no semantic match")
      console.log("[resolve-missing-words] rejection reason: unsupported decision type")
      return
    }

    console.log(`[resolver] Gemini candidates for ${originalWord}: ${candidates.map(normalizeWord).join(", ")}`)

    let replacementWord: string | undefined
    let matchedCandidate = ""
    for (const candidate of candidates) {
      const normalizedCandidate = normalizeWord(candidate)
      if (!normalizedCandidate) continue
      if (
        GENERIC_HELPER_WORDS.has(originalWord) &&
        WEAK_GENERIC_HELPER_CANDIDATES.has(normalizedCandidate) &&
        !allowsGenericActionCandidate(sentence)
      ) {
        console.log(`[resolver] weak candidate rejected: ${originalWord} -> ${normalizedCandidate}`)
        continue
      }
      if (originalWord === "did" && normalizedCandidate === "make" && !allowsDidToMake(sentence)) {
        console.log("[resolver] checking candidate make: rejected for generic did/do context")
        console.log("[resolve-missing-words] rejection reason: did should not map to make unless context means create/build")
        continue
      }

      const directMatch = dictionaryLookup.get(normalizedCandidate)
      console.log(`[resolver] checking candidate ${normalizedCandidate}: inDictionary=${Boolean(directMatch)}`)
      if (directMatch) {
        replacementWord = directMatch
        matchedCandidate = normalizedCandidate
        break
      }

      const synonymResolved = synonymMap[normalizedCandidate]
      const synonymMatch = synonymResolved ? dictionaryLookup.get(normalizeWord(synonymResolved)) : undefined
      console.log(
        `[resolver] checking candidate ${normalizedCandidate}: synonymMapMatch=${Boolean(synonymResolved)}, mappedWord=${synonymResolved || ""}, mappedInDictionary=${Boolean(synonymMatch)}`,
      )
      if (synonymMatch) {
        replacementWord = synonymMatch
        matchedCandidate = normalizedCandidate
        break
      }
    }

    console.log(`[resolve-missing-words] validating decision: ${originalWord} -> ${matchedCandidate || "no valid candidate"}`)
    console.log(`[resolve-missing-words] dictionary has resolvedWord: ${Boolean(replacementWord)}`)

    if (!replacementWord) {
      fingerspellWords.add(originalWord)
      fingerspellReasons.set(originalWord, "no valid Gemini candidate")
      if (GENERIC_HELPER_WORDS.has(originalWord)) {
        console.log(`[resolver] no safe semantic match for ${originalWord}`)
        console.log(`[resolver] fallback to fingerspelling: ${originalWord}`)
      }
      console.log("[resolve-missing-words] rejection reason: no candidate exists in dictionary or synonymMap")
      return
    }

    replacementsByOriginal.set(originalWord, {
      originalWord,
      replacementWord,
      confidence: "medium",
      reason: `AI concept candidate matched via ${matchedCandidate}`,
    })
    console.log(`[resolve-missing-words] AI semantic fallback: ${originalWord} -> ${replacementWord}`)
    console.log(`[resolver] AI semantic fallback: ${originalWord} → ${replacementWord}`)
    resolverLog(`Gemini semantic match: ${replacementWord}`)
    resolverLog(`resolvedWord exists in dictionary: ${dictionarySet.has(replacementWord)}`)
    resolverLog("final resolution type: ai_semantic_match")
  })

  const replacementsList = Array.from(replacementsByOriginal.values())
  const resolved = new Set(replacementsList.map((replacement) => replacement.originalWord))

  return {
    replacements: replacementsList,
    fingerspellWords: Array.from(fingerspellWords).filter((word) => !resolved.has(word)),
    fingerspellReasons,
    invalidDictionaryWords,
    unresolved: missingWords.filter((word) => !resolved.has(word)),
  }
}

function getWordFormFallbackReplacements(
  missingWords: string[],
  dictionaryWords: string[],
) {
  const dictionarySet = new Set(dictionaryWords)
  const replacements: MissingWordReplacement[] = []

  missingWords.forEach((word) => {
    const candidates = WORD_FORM_CANDIDATES[normalizeWord(word)] || []
    const replacementWord = candidates.find((candidate) => dictionarySet.has(candidate))
    if (!replacementWord) return

    console.log(`[resolve-missing-words] word-form fallback: ${word} -> ${replacementWord}`)
    replacements.push({
      originalWord: normalizeWord(word),
      replacementWord,
      confidence: "high",
      reason: "Common English word form mapped to supported root sign",
    })
  })

  return replacements
}

function getLocalFallbackReplacements(
  missingWords: string[],
  dictionaryWords: string[],
) {
  const dictionarySet = new Set(dictionaryWords)
  const replacements: MissingWordReplacement[] = []

  missingWords.forEach((word) => {
    const candidates = LOCAL_CONCEPT_CANDIDATES[word.toLowerCase()] || []
    const replacementWord = candidates.find((candidate) => dictionarySet.has(candidate))
    if (!replacementWord) return

    console.log(`[resolve-missing-words] AI semantic fallback: ${word} -> ${replacementWord}`)

    replacements.push({
      originalWord: word,
      replacementWord,
      confidence: ["thank you", "upset"].includes(replacementWord) ? "high" : "medium",
      reason: replacementWord === "thank you"
        ? "Common equivalent phrase found in dictionary"
        : "Closest supported dictionary meaning",
    })
  })

  return replacements
}

function mergeValidatedReplacements(
  missingWords: string[],
  dictionaryWords: string[],
  ...replacementGroups: MissingWordReplacement[][]
) {
  const dictionarySet = new Set(dictionaryWords)
  const replacementsByOriginal = new Map<string, MissingWordReplacement>()

  replacementGroups.flat().forEach((replacement) => {
    if (replacementsByOriginal.has(replacement.originalWord)) return
    if (!dictionarySet.has(replacement.replacementWord)) return
    replacementsByOriginal.set(replacement.originalWord, replacement)
  })

  const replacements = Array.from(replacementsByOriginal.values()).filter((replacement) =>
    dictionarySet.has(replacement.replacementWord),
  )
  const resolved = new Set(replacements.map((replacement) => replacement.originalWord))

  return {
    replacements,
    unresolved: missingWords.filter((word) => !resolved.has(word)),
  }
}

async function resolveMissingWordsWithGemini({
  sentence,
  missingWords,
}: ResolveMissingWordsInput): Promise<ModelDecision[]> {
  const apiKey = process.env.GEMINI_API_KEY
  resolverLog(`GEMINI_API_KEY exists: ${Boolean(apiKey)}`)
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY missing")
  }

  missingWords.forEach((word) => {
    console.log(`[resolve-missing-words] AI check for ${word}`)
    resolverLog(`AI check for ${word}`)
  })

  const prompt = [
    "You are helping a sign language animation app.",
    "",
    "Given:",
    "- a sentence",
    "- missing words",
    "",
    "For each missing word, return short ranked English concept candidates that could represent the meaning in ASL.",
    "",
    "Rules:",
    "- Return one decision for every missing word.",
    "- Use type \"concept_candidates\" for normal English concepts.",
    "- Return 5 to 10 candidates max per word.",
    "- Candidates must be simple lowercase English base/root words.",
    "- Prefer common ASL-friendly concepts.",
    "- For names, brands, acronyms, usernames, places, or unknown proper nouns, return type \"fingerspell\" with an empty candidates array.",
    "- Do not explain.",
    "- Do not use markdown.",
    "- Return JSON only.",
    "",
    "Examples:",
    'frustration -> {"type":"concept_candidates","candidates":["upset","angry","mad","sad","annoyed"]}',
    'fallback -> {"type":"concept_candidates","candidates":["help","support","use","backup","alternate"]}',
    'came -> {"type":"concept_candidates","candidates":["come","arrive","go","visit","enter"]}',
    'Gauri -> {"type":"fingerspell","candidates":[]}',
    'ChatGPT -> {"type":"fingerspell","candidates":[]}',
    'UCSC -> {"type":"fingerspell","candidates":[]}',
    'Starbucks -> {"type":"fingerspell","candidates":[]}',
    "",
    "Return this JSON shape only:",
    '{"decisions":[{"originalWord":"frustration","type":"concept_candidates","candidates":["upset","angry","mad","sad","annoyed"]},{"originalWord":"Gauri","type":"fingerspell","candidates":[]}]}',
    "",
    JSON.stringify({
      sentence,
      missingWords,
    }),
  ].join("\n")

  resolverLog("calling Gemini...")
  const geminiStartedAt = Date.now()
  let response: Response
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 600,
            responseMimeType: "application/json",
          },
        }),
      },
    )
  } catch (error) {
    resolverLog(`Gemini request duration in ms: ${Date.now() - geminiStartedAt}`)
    resolverLog(`Gemini error message: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
  resolverLog(`Gemini request duration in ms: ${Date.now() - geminiStartedAt}`)

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    resolverLog(`Gemini error message: Gemini request failed: ${response.status} ${errorText}`)
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`)
  }

  const data = (await response.json()) as GeminiResponse
  const rawText = getGeminiRawText(data)

  console.log("[resolve-missing-words] Gemini response object:", JSON.stringify(data, null, 2))
  console.log("[resolve-missing-words] Gemini full raw response string length:", rawText.length)
  console.log(`[resolve-missing-words] Gemini full raw response string:\n${rawText}`)
  resolverLog("Gemini raw response:", rawText)

  if (!rawText) {
    resolverLog("Gemini parsed response:", [])
    console.log("[resolve-missing-words] Gemini parse skipped: no text found in response candidates/content parts")
    console.log("[resolve-missing-words] Gemini parsed decisions:", [])
    return []
  }

  const { parsed, jsonText, error } = parseModelJson(rawText)
  const decisions = parsed.decisions || parsed.replacements || []
  console.log(`[resolve-missing-words] Gemini extracted JSON text:\n${jsonText}`)
  if (error) {
    console.log("[resolve-missing-words] Gemini JSON parse error:", error)
  }
  if (!Array.isArray(parsed.decisions)) {
    console.log("[resolve-missing-words] Gemini decisions missing or not an array.")
  }
  console.log("[resolve-missing-words] Gemini parsed decisions:", JSON.stringify(decisions, null, 2))
  resolverLog("Gemini parsed response:", parsed)
  return decisions
}

export async function POST(request: Request) {
  const body = validateBody((await request.json().catch(() => ({}))) as ResolveMissingWordsBody)

  resolverLog("resolver API route called")
  resolverLog("starting resolution")
  resolverLog("missing words received:", body.missingWords)
  resolverLog(`available dictionary word count: ${body.dictionaryWords.length}`)
  console.log("[resolve-missing-words] missingWords:", body.missingWords)
  console.log("[resolve-missing-words] dictionaryWords count:", body.dictionaryWords.length)

  if (!body.sentence || !body.missingWords.length || !body.dictionaryWords.length) {
    return emptyResponse(body.missingWords)
  }

  const wordFormReplacements = getWordFormFallbackReplacements(body.missingWords, body.dictionaryWords)
  const wordFormResolved = new Set(wordFormReplacements.map((replacement) => replacement.originalWord))
  const geminiMissingWords = body.missingWords.filter((word) => !wordFormResolved.has(normalizeWord(word)))
  const dictionarySet = new Set(body.dictionaryWords)
  const synonymMap = await readSynonymMap()

  body.missingWords.forEach((word) => {
    const normalizedWord = normalizeWord(word)
    const synonymMatch = synonymMap[normalizedWord]
    resolverLog(`input word: ${word}`)
    resolverLog(`exact dictionary match: ${dictionarySet.has(normalizedWord)}`)
    resolverLog(`synonymMap match: ${Boolean(synonymMatch)}${synonymMatch ? ` (${normalizedWord} -> ${synonymMatch})` : ""}`)
  })

  try {
    const geminiReplacements = geminiMissingWords.length
      ? await resolveMissingWordsWithGemini({
          sentence: body.sentence,
          missingWords: geminiMissingWords,
        })
      : []
    if (!geminiMissingWords.length) {
      console.log("[resolve-missing-words] Gemini raw response:", "skipped; all missing words resolved locally")
    }

    const validatedGemini = validateModelDecisions(
      geminiReplacements,
      geminiMissingWords,
      body.dictionaryWords,
      synonymMap,
      body.sentence,
    )
    const backupFallbackReplacements = getLocalFallbackReplacements(validatedGemini.unresolved, body.dictionaryWords)
    await Promise.all(
      [...validatedGemini.replacements, ...backupFallbackReplacements].map((replacement) =>
        addSynonymMapping(
          replacement.originalWord,
          replacement.replacementWord,
          body.dictionaryWords,
          replacement.confidence,
        ),
      ),
    )
    const finalReplacements = mergeValidatedReplacements(
      body.missingWords,
      body.dictionaryWords,
      wordFormReplacements,
      validatedGemini.replacements,
      backupFallbackReplacements,
    )
    console.log("[resolve-missing-words] final validated replacements:", finalReplacements.replacements)
    body.missingWords.forEach((word) => {
      const normalizedWord = normalizeWord(word)
      const replacement = finalReplacements.replacements.find((item) => item.originalWord === normalizedWord)
      if (replacement) {
        const resolutionType = wordFormResolved.has(normalizedWord)
          ? "word_form_match"
          : validatedGemini.replacements.some((item) => item.originalWord === normalizedWord)
            ? "ai_semantic_match"
            : "local_semantic_match"
        resolverLog(`final resolution type: ${resolutionType}`)
        return
      }

      resolverLog("final resolution type: fingerspell")
      resolverLog(`fingerspell reason: ${validatedGemini.fingerspellReasons.get(normalizedWord) || "no semantic match"}`)
      const invalidWord = validatedGemini.invalidDictionaryWords.get(normalizedWord)
      if (invalidWord) {
        resolverLog(`invalid dictionary word: ${invalidWord}`)
      }
    })
    return NextResponse.json(finalReplacements)
  } catch (error) {
    console.log("[resolve-missing-words] Gemini error:", error instanceof Error ? error.message : error)
    resolverLog(`Gemini error message: ${error instanceof Error ? error.message : String(error)}`)
    const fallbackOnly = mergeValidatedReplacements(
      body.missingWords,
      body.dictionaryWords,
      wordFormReplacements,
      getLocalFallbackReplacements(geminiMissingWords, body.dictionaryWords),
    )
    console.log("[resolve-missing-words] final validated replacements:", fallbackOnly.replacements)
    body.missingWords.forEach((word) => {
      const normalizedWord = normalizeWord(word)
      const replacement = fallbackOnly.replacements.find((item) => item.originalWord === normalizedWord)
      resolverLog(`final resolution type: ${replacement ? "local_semantic_match" : "fingerspell"}`)
      if (!replacement) {
        resolverLog("fingerspell reason: Gemini failed")
      }
    })
    return NextResponse.json(fallbackOnly)
  }
}
