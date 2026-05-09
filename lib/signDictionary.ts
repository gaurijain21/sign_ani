"use client"

import { collection, getDocs, orderBy, query } from "firebase/firestore"
import { getDownloadURL, ref } from "firebase/storage"
import { getFirebaseDb, getFirebaseStorage, hasFirebaseConfig } from "./firebase"
import type { MissingWordReplacement, PlaybackQueueItem, SignData, SignDictionaryEntry } from "./types"

const FILLER_WORDS = new Set(["a", "an", "the", "is", "am", "are", "to", "of"])
const animationCache = new Map<string, SignData>()

export function normalizeSentence(input: string): string {
  return input
    .toLowerCase()
    .replace(/\bcan't\b/g, "can not")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bi'm\b/g, "i am")
    .replace(/\byou're\b/g, "you are")
    .replace(/\bthey're\b/g, "they are")
    .replace(/\bwe're\b/g, "we are")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function tokenizeSentence(input: string): string[] {
  const normalized = normalizeSentence(input)
  return normalized ? normalized.split(" ") : []
}

function normalizeGloss(gloss: string): string {
  return normalizeSentence(gloss)
}

function entryKey(gloss: string): string {
  return normalizeGloss(gloss)
}

export async function loadSignDictionary(): Promise<{
  entries: SignDictionaryEntry[]
  source: "firebase" | "local"
}> {
  if (hasFirebaseConfig()) {
    const db = getFirebaseDb()
    if (db) {
      const snapshot = await getDocs(query(collection(db, "signs"), orderBy("gloss")))
      return {
        entries: snapshot.docs.map((doc) => {
          const data = doc.data() as SignDictionaryEntry
          return {
            ...data,
            gloss: normalizeGloss(data.gloss || doc.id),
            aliases: data.aliases || [],
            available: Boolean(data.available),
          }
        }),
        source: "firebase",
      }
    }
  }

  const response = await fetch("/api/sign-dictionary")
  if (!response.ok) {
    throw new Error("Unable to load sign dictionary.")
  }
  const data = await response.json()
  return {
    entries: data.entries || [],
    source: "local",
  }
}

export function parseSentenceToQueue(
  input: string,
  dictionary: SignDictionaryEntry[],
  showSkippedWords: boolean,
): PlaybackQueueItem[] {
  const tokens = tokenizeSentence(input)
  const lookup = new Map<string, SignDictionaryEntry>()
  let maxPhraseLength = 1

  dictionary.forEach((entry) => {
    const keys = [entry.gloss, ...(entry.aliases || [])].map(entryKey).filter(Boolean)
    keys.forEach((key) => {
      lookup.set(key, entry)
      maxPhraseLength = Math.max(maxPhraseLength, key.split(" ").length)
    })
  })

  const queue: PlaybackQueueItem[] = []
  let index = 0

  while (index < tokens.length) {
    let match: { text: string; entry: SignDictionaryEntry; length: number } | null = null
    const remaining = tokens.length - index
    const phraseLimit = Math.min(maxPhraseLength, remaining)

    for (let length = phraseLimit; length >= 1; length--) {
      const text = tokens.slice(index, index + length).join(" ")
      const entry = lookup.get(text)
      if (entry) {
        match = { text, entry, length }
        break
      }
    }

    if (match) {
      queue.push({
        id: `${queue.length}-${match.text}`,
        text: match.text,
        gloss: match.entry.gloss,
        type: match.entry.type,
        status: match.entry.available ? "available" : "unavailable",
        entry: match.entry,
        reason: match.entry.available ? undefined : `Sign unavailable: ${match.text}`,
      })
      index += match.length
      continue
    }

    const token = tokens[index]
    if (FILLER_WORDS.has(token)) {
      if (showSkippedWords) {
        queue.push({
          id: `${queue.length}-${token}`,
          text: token,
          gloss: token,
          type: "filler",
          status: "skipped",
          reason: "Skipped filler word",
        })
      }
      index += 1
      continue
    }

    queue.push({
      id: `${queue.length}-${token}`,
      text: token,
      gloss: token,
      type: "word",
      status: "unavailable",
      reason: `Sign unavailable: ${token}`,
    })
    index += 1
  }

  return queue
}

export type ResolveSentenceResult = {
  queue: PlaybackQueueItem[]
  replacements: MissingWordReplacement[]
  unresolved: string[]
  aiUnavailable: boolean
}

export async function resolveSentenceWithAI(
  input: string,
  dictionary: SignDictionaryEntry[],
  showSkippedWords: boolean,
): Promise<ResolveSentenceResult> {
  const queue = parseSentenceToQueue(input, dictionary, showSkippedWords)
  const missingWords = Array.from(
    new Set(
      queue
        .filter((item) => item.status === "unavailable" && !item.entry)
        .map((item) => item.text),
    ),
  )

  if (!missingWords.length) {
    return { queue, replacements: [], unresolved: [], aiUnavailable: false }
  }

  const availableEntries = dictionary.filter((entry) => entry.available)
  const entryLookup = new Map<string, SignDictionaryEntry>()
  availableEntries.forEach((entry) => {
    entryLookup.set(entry.gloss, entry)
  })

  const dictionaryWords = Array.from(entryLookup.keys())
  if (!dictionaryWords.length) {
    return { queue, replacements: [], unresolved: missingWords, aiUnavailable: true }
  }

  try {
    const response = await fetch("/api/resolve-missing-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sentence: input,
        missingWords,
        dictionaryWords,
      }),
    })

    if (!response.ok) {
      return { queue, replacements: [], unresolved: missingWords, aiUnavailable: true }
    }

    const data = (await response.json()) as {
      replacements?: MissingWordReplacement[]
      unresolved?: string[]
    }

    const replacements = (data.replacements || []).filter((replacement) =>
      entryLookup.has(replacement.replacementWord),
    )
    const replacementLookup = new Map(replacements.map((replacement) => [replacement.originalWord, replacement]))

    const resolvedQueue = queue.map((item) => {
      const replacement = replacementLookup.get(item.text)
      const entry = replacement ? entryLookup.get(replacement.replacementWord) : undefined
      if (!replacement || !entry) return item

      return {
        ...item,
        gloss: entry.gloss,
        type: entry.type,
        status: "available" as const,
        entry,
        reason: replacement.reason,
        replacement,
      }
    })

    const resolvedWords = new Set(replacements.map((replacement) => replacement.originalWord))
    const unresolved = Array.from(
      new Set([...(data.unresolved || []), ...missingWords.filter((word) => !resolvedWords.has(word))]),
    )

    return {
      queue: resolvedQueue,
      replacements,
      unresolved,
      aiUnavailable: false,
    }
  } catch {
    return { queue, replacements: [], unresolved: missingWords, aiUnavailable: true }
  }
}

export async function fetchSignAnimation(entry: SignDictionaryEntry): Promise<SignData> {
  const key = entry.jsonUrl || entry.jsonPath || entry.gloss
  const cached = animationCache.get(key)
  if (cached) {
    return cached
  }

  if (!entry.available) {
    throw new Error(`Sign unavailable: ${entry.gloss}`)
  }

  let url = entry.jsonUrl
  const storage = getFirebaseStorage()
  if (!url && storage && entry.jsonPath) {
    url = await getDownloadURL(ref(storage, entry.jsonPath))
  }

  if (!url) {
    url = entry.jsonPath?.startsWith("/")
      ? entry.jsonPath
      : `/data/signs/${encodeURIComponent(entry.gloss.replace(/\s+/g, "_"))}.json`
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Unable to load animation for ${entry.gloss}.`)
  }

  const data = (await response.json()) as SignData
  if (!data.frames?.length) {
    throw new Error(`Animation file for ${entry.gloss} is empty or invalid.`)
  }

  const animation = {
    ...data,
    word: data.word || entry.gloss,
    fps: data.fps || entry.fps || 30,
    source: "wlasl" as const,
  }
  animationCache.set(key, animation)
  return animation
}
