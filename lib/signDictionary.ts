"use client"

import { collection, getDocs, orderBy, query } from "firebase/firestore"
import { getDownloadURL, ref } from "firebase/storage"
import { getFirebaseDb, getFirebaseStorage, hasFirebaseConfig } from "./firebase"
import type { PlaybackQueueItem, SignData, SignDictionaryEntry } from "./types"

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
    url = `/api/signs/${encodeURIComponent(entry.gloss)}`
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
