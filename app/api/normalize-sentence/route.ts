import { NextResponse } from "next/server"

export const runtime = "nodejs"

type NormalizeSentenceBody = {
  text?: unknown
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

const GEMINI_MODEL = "gemini-2.5-flash"
const PROTECTED_PHRASES: Array<[RegExp, string]> = [
  [/\btype\s+a\s+word\s+here\b/gi, "type word here"],
  [/\bthank\s*you\b/gi, "thank you"],
  [/\bthankyou\b/gi, "thank you"],
  [/\bthanks\b/gi, "thank you"],
  [/\bgoodbye\b/gi, "good bye"],
  [/\bno\s*way\b/gi, "no way"],
  [/\bnoway\b/gi, "no way"],
  [/\bdont\s*know\b/gi, "don't know"],
  [/\bdon't\s*know\b/gi, "don't know"],
  [/\bidk\b/gi, "don't know"],
  [/\bi\s*love\s*you\b/gi, "i love you"],
  [/\biloveyou\b/gi, "i love you"],
]

function getGeminiRawText(data: GeminiResponse) {
  return (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim()
}

function extractJsonText(content: string) {
  const unfenced = content
    .trim()
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

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function applyProtectedPhraseNormalizations(text: string) {
  let normalized = text
  const hits: string[] = []

  PROTECTED_PHRASES.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, (match) => {
      hits.push(`${match} -> ${replacement}`)
      return replacement
    })
  })

  normalized = normalized
    .replace(/\bjust\s+did\s+that\b/gi, "do that")
    .replace(/\bdid\s+that\b/gi, "do that")

  return {
    text: normalizeWhitespace(normalized),
    hits,
  }
}

async function normalizeSentenceForSigning(inputText: string) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY missing")
  }

  const prompt = [
    "You rewrite English into a short sign-friendly English/gloss-like phrase for an ASL learning app.",
    'Return ONLY this minified JSON object: {"normalizedText":"...","reason":"..."}',
    "No markdown.",
    "No explanation.",
    "No leading text.",
    "Do not write \"Here is\".",
    "No prose before or after JSON.",
    "",
    "Rules:",
    "- Preserve the original meaning.",
    "- Convert slang, typos, and casual wording into clearer words.",
    "- Prefer simple root/base words.",
    "- Avoid unnecessary filler words.",
    "- Do not use complex words.",
    "- Do not invent unrelated meaning.",
    "- Keep names, brands, acronyms, usernames, and places unchanged so they can be fingerspelled later.",
    "- For generic phrases like \"you did that\", use \"you do that\".",
    "- Do not rewrite generic did/do into make unless the input clearly means create/build.",
    "- Return ONLY valid minified JSON.",
    "",
    "Examples:",
    '{"input":"noway you just did that","normalizedText":"no way you do that","reason":"Converted slang and simplified verb form"}',
    '{"input":"i am so frustrated rn","normalizedText":"i upset now","reason":"Simplified emotion and time slang"}',
    '{"input":"gauri went to ucsc","normalizedText":"gauri go ucsc","reason":"Simplified verb form and kept names/acronym"}',
    '{"input":"i just bought a car","normalizedText":"i buy car","reason":"Removed filler and simplified verb form"}',
    "",
    "Return this JSON shape only, minified:",
    '{"normalizedText":"no way you do that","reason":"Converted slang and simplified verb form"}',
    "",
    JSON.stringify({ input: inputText }),
  ].join("\n")

  const startedAt = Date.now()
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
          maxOutputTokens: 256,
          responseMimeType: "application/json",
        },
      }),
    },
  )

  console.log(`[normalize] Gemini request duration in ms: ${Date.now() - startedAt}`)

  if (!response.ok) {
    throw new Error(`Gemini normalization failed: ${response.status} ${await response.text().catch(() => "")}`)
  }

  const data = (await response.json()) as GeminiResponse
  const rawText = getGeminiRawText(data)
  const jsonText = extractJsonText(rawText)
  let parsed: { normalizedText?: unknown; reason?: unknown }
  try {
    parsed = JSON.parse(jsonText) as { normalizedText?: unknown; reason?: unknown }
  } catch (error) {
    console.log(`[normalize] Gemini raw response parse failure:\n${rawText}`)
    console.log(`[normalize] extracted JSON candidate:\n${jsonText}`)
    throw error
  }
  const normalizedText = typeof parsed.normalizedText === "string"
    ? applyProtectedPhraseNormalizations(parsed.normalizedText).text
    : ""

  if (!normalizedText) {
    throw new Error("Gemini normalization returned no normalizedText")
  }

  return {
    normalizedText,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as NormalizeSentenceBody
  const rawOriginal = typeof body.text === "string" ? normalizeWhitespace(body.text) : ""
  const protectedOriginal = applyProtectedPhraseNormalizations(rawOriginal)
  const original = protectedOriginal.text

  console.log(`[normalize] original: ${original}`)
  protectedOriginal.hits.forEach((hit) => {
    console.log(`[phrase-normalizer] protected phrase hit: ${hit}`)
    console.log("[resolver] bypassing AI semantic replacement for protected phrase")
  })

  if (!original) {
    return NextResponse.json({ normalizedText: "", reason: "Empty input" })
  }

  if (protectedOriginal.hits.length) {
    console.log(`[normalize] Gemini normalized: ${original}`)
    console.log(`[resolver] resolving normalized words: ${JSON.stringify(original.split(/\s+/).filter(Boolean))}`)
    return NextResponse.json({
      normalizedText: original,
      reason: "Applied protected/common phrase normalization",
    })
  }

  try {
    const result = await normalizeSentenceForSigning(original)
    console.log(`[normalize] Gemini normalized: ${result.normalizedText}`)
    console.log(`[normalize] reason: ${result.reason}`)
    console.log(`[resolver] resolving normalized words: ${JSON.stringify(result.normalizedText.split(/\s+/).filter(Boolean))}`)
    return NextResponse.json(result)
  } catch (error) {
    console.log("[normalize] Gemini normalization error:", error instanceof Error ? error.message : error)
    console.log(`[normalize] Gemini normalized: ${original}`)
    console.log(`[resolver] resolving normalized words: ${JSON.stringify(original.split(/\s+/).filter(Boolean))}`)
    return NextResponse.json({
      normalizedText: original,
      reason: "Normalization failed; using original input",
      error: error instanceof Error ? error.message : "Normalization failed",
    })
  }
}
