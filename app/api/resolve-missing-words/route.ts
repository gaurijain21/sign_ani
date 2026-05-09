import { NextResponse } from "next/server"
import type { MissingWordConfidence, MissingWordReplacement } from "@/lib/types"

type ResolveMissingWordsBody = {
  sentence?: unknown
  missingWords?: unknown
  dictionaryWords?: unknown
}

type ModelReplacement = {
  originalWord?: unknown
  replacementWord?: unknown
  confidence?: unknown
  reason?: unknown
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
  }>
}

type ResolveMissingWordsInput = {
  sentence: string
  missingWords: string[]
  dictionaryWords: string[]
}

const GEMINI_MODEL = "gemini-2.5-flash"
const CONFIDENCES = new Set<MissingWordConfidence>(["low", "medium", "high"])
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
  return NextResponse.json({
    replacements: [],
    unresolved: missingWords,
    ...(error ? { error } : {}),
  })
}

function parseModelJson(content: string): { replacements?: ModelReplacement[] } {
  const trimmed = content.trim()
  const jsonText = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()

  try {
    return JSON.parse(jsonText)
  } catch {
    return {}
  }
}

function validateReplacements(
  replacements: ModelReplacement[] | undefined,
  missingWords: string[],
  dictionaryWords: string[],
) {
  const missingSet = new Set(missingWords)
  const dictionarySet = new Set(dictionaryWords)
  const replacementsByOriginal = new Map<string, MissingWordReplacement>()

  ;(replacements || []).forEach((replacement) => {
    if (
      typeof replacement.originalWord !== "string" ||
      typeof replacement.replacementWord !== "string" ||
      !missingSet.has(replacement.originalWord) ||
      !dictionarySet.has(replacement.replacementWord)
    ) {
      return
    }

    const confidence = CONFIDENCES.has(replacement.confidence as MissingWordConfidence)
      ? (replacement.confidence as MissingWordConfidence)
      : "low"

    replacementsByOriginal.set(replacement.originalWord, {
      originalWord: replacement.originalWord,
      replacementWord: replacement.replacementWord,
      confidence,
      reason: typeof replacement.reason === "string" ? replacement.reason : "Closest supported dictionary meaning",
    })
  })

  const replacementsList = Array.from(replacementsByOriginal.values())
  const resolved = new Set(replacementsList.map((replacement) => replacement.originalWord))

  return {
    replacements: replacementsList,
    unresolved: missingWords.filter((word) => !resolved.has(word)),
  }
}

function getLocalFallbackReplacements(
  missingWords: string[],
  dictionaryWords: string[],
) {
  const dictionarySet = new Set(dictionaryWords)
  const replacements: MissingWordReplacement[] = []

  missingWords.forEach((word) => {
    const candidates = COMMON_REPLACEMENT_CANDIDATES[word.toLowerCase()] || []
    const replacementWord = candidates.find((candidate) => dictionarySet.has(candidate))
    if (!replacementWord) return

    replacements.push({
      originalWord: word,
      replacementWord,
      confidence: replacementWord === "thank you" ? "high" : "medium",
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
  dictionaryWords,
}: ResolveMissingWordsInput): Promise<ModelReplacement[]> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY missing")
  }

  const prompt = [
    "You are helping a sign language animation app.",
    "",
    "Given:",
    "- a sentence",
    "- missing words",
    "- a list of supported dictionary entries",
    "",
    "Choose the closest supported replacement for each missing word.",
    "Supported dictionary entries may be single words or phrases like \"thank you\".",
    "You may choose a phrase if it better matches the missing word.",
    "",
    "Rules:",
    "- The replacementWord must exactly match one item from dictionaryWords.",
    "- Prefer the closest meaning in context.",
    "- Prefer simple/common words.",
    "- Return null only if there is truly no useful replacement.",
    "- Return strict JSON only.",
    "",
    "Examples:",
    "hey -> hello",
    "hi -> hello",
    "thanks -> thank you",
    "thankyou -> thank you",
    "exhausting -> tired",
    "tiring -> tired",
    "accessibility -> access",
    "accessible -> access",
    "",
    "Return this JSON shape only:",
    '{"replacements":[{"originalWord":"thanks","replacementWord":"thank you"}]}',
    "",
    JSON.stringify({
      sentence,
      missingWords,
      dictionaryWords,
    }),
  ].join("\n")

  const response = await fetch(
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

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${await response.text().catch(() => "")}`)
  }

  const data = (await response.json()) as GeminiResponse
  const rawText = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim()

  console.log("[resolve-missing-words] Gemini raw response:", rawText ?? data)

  if (!rawText) {
    return []
  }

  return parseModelJson(rawText).replacements || []
}

export async function POST(request: Request) {
  const body = validateBody((await request.json().catch(() => ({}))) as ResolveMissingWordsBody)

  console.log("[resolve-missing-words] missingWords:", body.missingWords)
  console.log("[resolve-missing-words] dictionaryWords count:", body.dictionaryWords.length)

  if (!body.sentence || !body.missingWords.length || !body.dictionaryWords.length) {
    return emptyResponse(body.missingWords)
  }

  const localFallbackReplacements = getLocalFallbackReplacements(body.missingWords, body.dictionaryWords)
  console.log("[resolve-missing-words] local fallback replacements:", localFallbackReplacements)

  const locallyResolved = new Set(localFallbackReplacements.map((replacement) => replacement.originalWord))
  const geminiMissingWords = body.missingWords.filter((word) => !locallyResolved.has(word))

  try {
    const geminiReplacements = geminiMissingWords.length
      ? await resolveMissingWordsWithGemini({
          sentence: body.sentence,
          missingWords: geminiMissingWords,
          dictionaryWords: body.dictionaryWords,
        })
      : []
    if (!geminiMissingWords.length) {
      console.log("[resolve-missing-words] Gemini raw response:", "skipped; all missing words resolved locally")
    }

    const validatedGemini = validateReplacements(geminiReplacements, geminiMissingWords, body.dictionaryWords)
    const backupFallbackReplacements = getLocalFallbackReplacements(validatedGemini.unresolved, body.dictionaryWords)
    const finalReplacements = mergeValidatedReplacements(
      body.missingWords,
      body.dictionaryWords,
      localFallbackReplacements,
      validatedGemini.replacements,
      backupFallbackReplacements,
    )
    console.log("[resolve-missing-words] final validated replacements:", finalReplacements.replacements)
    return NextResponse.json(finalReplacements)
  } catch (error) {
    console.log("[resolve-missing-words] Gemini error:", error instanceof Error ? error.message : error)
    const fallbackOnly = mergeValidatedReplacements(
      body.missingWords,
      body.dictionaryWords,
      localFallbackReplacements,
      getLocalFallbackReplacements(geminiMissingWords, body.dictionaryWords),
    )
    console.log("[resolve-missing-words] final validated replacements:", fallbackOnly.replacements)
    return NextResponse.json(fallbackOnly)
  }
}
