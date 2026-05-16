"use client"

import { collection, getDocs, orderBy, query } from "firebase/firestore"
import { getDownloadURL, ref } from "firebase/storage"
import { getFirebaseDb, getFirebaseStorage, hasFirebaseConfig } from "./firebase"
import type { Landmark, MissingWordReplacement, PlaybackQueueItem, SignData, SignDictionaryEntry } from "./types"

const FILLER_WORDS = new Set(["a", "an", "the", "is", "am", "are", "to", "of"])
const ASL_LETTERS = /^[A-Z]$/
const FINGERSPELL_HAND_SCALE = 0.32
const FINGERSPELL_RIGHT_SHOULDER = { x: 0.58, y: 0.45 }
const FINGERSPELL_LEFT_SHOULDER = { x: 0.42, y: 0.45 }
const FINGERSPELL_RIGHT_WRIST_OFFSET = { x: 0.18, y: -0.06 }
const FINGERSPELL_ELBOW_BEND_OFFSET = 0.07
// Fingerspelling has its own timing so letter fallback is readable without
// slowing down regular WLASL signs.
const FINGERSPELL_FPS = 30
const FINGERSPELL_LETTER_DURATION_MS = 900
const FINGERSPELL_MOTION_LETTER_DURATION_MS = 1300
const FINGERSPELL_LETTER_PAUSE_MS = 150
const FINGERSPELL_TRANSITION_MS = 120
const FINGERSPELL_MOTION_PATH_SCALE = 0.45
const USE_FIRESTORE_SIGNS = process.env.NEXT_PUBLIC_USE_FIRESTORE_SIGNS === "true"
const animationCache = new Map<string, SignData>()
const synonymMapCache = {
  loaded: false,
  values: new Map<string, string>(),
}
const PROTECTED_PHRASES: Array<[RegExp, string]> = [
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

function logResolution(message: string) {
  console.log(`[word-resolution] ${message}`)
}

function applyProtectedPhraseNormalizations(input: string): string {
  let normalized = input

  PROTECTED_PHRASES.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, (match) => {
      console.log(`[phrase-normalizer] protected phrase hit: ${match} -> ${replacement}`)
      console.log("[resolver] bypassing AI semantic replacement for protected phrase")
      return replacement
    })
  })

  return normalized.replace(/\s+/g, " ").trim()
}

function lettersForFingerspelling(word: string): string[] {
  return word
    .toUpperCase()
    .split("")
    .filter((letter) => ASL_LETTERS.test(letter))
}

function cloneLandmarks(landmarks: Landmark[] | null | undefined): Landmark[] | null {
  if (!landmarks) return null
  return landmarks.map((point) => ({ ...point }))
}

function cloneFrame(frame: SignData["frames"][number]): SignData["frames"][number] {
  const frameWithMouth = frame as SignData["frames"][number] & {
    mouth?: Landmark[] | null
    mouthLandmarks?: Landmark[] | null
    mouth_landmarks?: Landmark[] | null
  }

  return {
    leftHand: cloneLandmarks(frame.leftHand),
    rightHand: cloneLandmarks(frame.rightHand),
    pose: cloneLandmarks(frame.pose),
    ...(frameWithMouth.mouth
      ? { mouth: cloneLandmarks(frameWithMouth.mouth) }
      : {},
    ),
    ...(frameWithMouth.mouthLandmarks
      ? { mouthLandmarks: cloneLandmarks(frameWithMouth.mouthLandmarks) }
      : {},
    ),
    ...(frameWithMouth.mouth_landmarks
      ? { mouth_landmarks: cloneLandmarks(frameWithMouth.mouth_landmarks) }
      : {},
    ),
  }
}

function interpolateLandmarks(
  first: Landmark[] | null | undefined,
  second: Landmark[] | null | undefined,
  amount: number,
): Landmark[] | null {
  if (!first || !second || first.length !== second.length) return cloneLandmarks(second || first)

  return first.map((point, index) => {
    const nextPoint = second[index]
    return {
      x: point.x + (nextPoint.x - point.x) * amount,
      y: point.y + (nextPoint.y - point.y) * amount,
      z: point.z !== undefined || nextPoint.z !== undefined
        ? (point.z || 0) + ((nextPoint.z || 0) - (point.z || 0)) * amount
        : undefined,
    }
  })
}

function interpolateFrame(
  first: SignData["frames"][number],
  second: SignData["frames"][number],
  amount: number,
): SignData["frames"][number] {
  return {
    leftHand: interpolateLandmarks(first.leftHand, second.leftHand, amount),
    rightHand: interpolateLandmarks(first.rightHand, second.rightHand, amount),
    pose: interpolateLandmarks(first.pose, second.pose, amount),
  }
}

function framesForDuration(durationMs: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * FINGERSPELL_FPS))
}

function stretchFramesToDuration(
  frames: SignData["frames"],
  frameCount: number,
): SignData["frames"] {
  if (!frames.length) return []

  return Array.from({ length: frameCount }, (_, index) => {
    const sourceIndex = Math.min(frames.length - 1, Math.floor((index / frameCount) * frames.length))
    return cloneFrame(frames[sourceIndex])
  })
}

function makePoint(x: number, y: number, z = 0): Landmark {
  return { x, y, z }
}

function averageLandmark(landmarks: Landmark[] | null | undefined): Landmark | null {
  if (!landmarks?.length) return null
  const total = landmarks.reduce(
    (sum, point) => ({
      x: sum.x + point.x,
      y: sum.y + point.y,
      z: sum.z + (point.z || 0),
    }),
    { x: 0, y: 0, z: 0 },
  )

  return {
    x: total.x / landmarks.length,
    y: total.y / landmarks.length,
    z: total.z / landmarks.length,
  }
}

function getFrameMouthLandmarks(frame: SignData["frames"][number]): Landmark[] | null {
  const frameWithMouth = frame as SignData["frames"][number] & {
    mouth?: Landmark[] | null
    mouthLandmarks?: Landmark[] | null
    mouth_landmarks?: Landmark[] | null
  }
  return frameWithMouth.mouthLandmarks || frameWithMouth.mouth_landmarks || frameWithMouth.mouth || null
}

function isThankYouSign(word: string): boolean {
  return normalizeGloss(word) === "thank you"
}

function correctThankYouLandmarks(data: SignData): SignData {
  if (!isThankYouSign(data.word)) return data

  console.log("[playback] applying sign-specific correction: thank you hand path near mouth/chin")
  const frameCount = Math.max(1, data.frames.length - 1)

  return {
    ...data,
    frames: data.frames.map((frame, index) => {
      const rightHand = cloneLandmarks(frame.rightHand)
      const pose = cloneLandmarks(frame.pose)
      const mouthCenter = averageLandmark(getFrameMouthLandmarks(frame))
      const handCenter = averageLandmark(rightHand)
      if (!rightHand?.length || !mouthCenter || !handCenter) {
        return cloneFrame(frame)
      }

      const progress = index / frameCount
      const targetCenter = {
        // ASL THANK-YOU starts by the mouth/chin and moves outward. The bundled
        // JSON drifts toward the chest, so this narrow correction only moves
        // this sign's hand path while preserving the local hand shape.
        x: mouthCenter.x + 0.03 + progress * 0.18,
        y: mouthCenter.y + 0.07 + progress * 0.05,
        z: handCenter.z,
      }
      const offset = {
        x: targetCenter.x - handCenter.x,
        y: targetCenter.y - handCenter.y,
        z: (targetCenter.z || 0) - (handCenter.z || 0),
      }
      const correctedRightHand = rightHand.map((point) => ({
        x: point.x + offset.x,
        y: point.y + offset.y,
        z: point.z !== undefined ? point.z + offset.z : undefined,
      }))

      if (pose?.[12] && correctedRightHand[0]) {
        const shoulder = pose[12]
        const wrist = correctedRightHand[0]
        pose[16] = { ...wrist }
        pose[14] = {
          x: shoulder.x + 0.55 * (wrist.x - shoulder.x),
          y: shoulder.y + 0.55 * (wrist.y - shoulder.y) + 0.02,
          z: wrist.z,
        }
      }

      return {
        ...cloneFrame(frame),
        rightHand: correctedRightHand,
        pose,
      }
    }),
    metadata: {
      ...(data.metadata || {}),
      signSpecificCorrection: "thank_you_mouth_start",
    },
  }
}

function formatPoint(point: Landmark | null | undefined): string {
  if (!point) return "missing"
  return `x=${point.x.toFixed(4)}, y=${point.y.toFixed(4)}, z=${(point.z || 0).toFixed(4)}`
}

function logPlaybackSignDiagnostics(entry: SignDictionaryEntry, url: string, data: SignData) {
  const firstFrame = data.frames[0]
  const rightWrist = firstFrame?.rightHand?.[0]
  const leftWrist = firstFrame?.leftHand?.[0]
  const mouthCenter = firstFrame ? averageLandmark(getFrameMouthLandmarks(firstFrame)) : null
  const leftShoulder = firstFrame?.pose?.[11]
  const rightShoulder = firstFrame?.pose?.[12]
  const chestCenter = leftShoulder && rightShoulder
    ? {
        x: (leftShoulder.x + rightShoulder.x) / 2,
        y: (leftShoulder.y + rightShoulder.y) / 2,
        z: ((leftShoulder.z || 0) + (rightShoulder.z || 0)) / 2,
      }
    : null

  console.log(`[playback] requested phrase: ${entry.gloss}`)
  console.log(`[playback] resolved signs: ${data.word || entry.gloss}`)
  console.log(`[playback] loaded file path: ${url}`)
  console.log(`[playback] frame count: ${data.frames.length}`)
  console.log(`[playback] first wrist position: right=${formatPoint(rightWrist)}, left=${formatPoint(leftWrist)}`)
  console.log(`[playback] first face/mouth/chin landmarks if available: mouth=${formatPoint(mouthCenter)}`)
  console.log(`[playback] first shoulder/chest landmarks if available: chest=${formatPoint(chestCenter)}`)
}

function makeFingerspellPose(wrist: Landmark): Landmark[] {
  const leftShoulder = makePoint(FINGERSPELL_LEFT_SHOULDER.x, FINGERSPELL_LEFT_SHOULDER.y)
  const rightShoulder = makePoint(FINGERSPELL_RIGHT_SHOULDER.x, FINGERSPELL_RIGHT_SHOULDER.y)
  const leftElbow = makePoint(leftShoulder.x - 0.08, leftShoulder.y + 0.16)
  const leftWrist = makePoint(leftShoulder.x - 0.11, leftShoulder.y + 0.32)
  const rightElbow = makePoint(
    rightShoulder.x + 0.35 * (wrist.x - rightShoulder.x),
    rightShoulder.y + 0.55 * (wrist.y - rightShoulder.y) + FINGERSPELL_ELBOW_BEND_OFFSET,
  )

  return [
    ...Array.from({ length: 11 }, () => makePoint(0.5, 0.2)),
    leftShoulder,
    rightShoulder,
    leftElbow,
    rightElbow,
    leftWrist,
    wrist,
  ]
}

function getPrimaryFingerspellHand(frame: SignData["frames"][number]): Landmark[] | null {
  return frame.rightHand?.length ? frame.rightHand : frame.leftHand?.length ? frame.leftHand : null
}

function isFingerspellMotionLetter(data: SignData): boolean {
  const metadata = data.metadata || {}
  return Boolean(
    metadata.isMotionLetter ||
      (data as SignData & { isMotionLetter?: boolean }).isMotionLetter ||
      metadata.source === "kaggle_asl_alphabet_video",
  )
}

function placeFingerspellHand(
  hand: Landmark[] | null,
  baseWrist?: Landmark | null,
): { hand: Landmark[] | null; wrist: Landmark } {
  const baseWristTarget = makePoint(
    FINGERSPELL_RIGHT_SHOULDER.x + FINGERSPELL_RIGHT_WRIST_OFFSET.x,
    FINGERSPELL_RIGHT_SHOULDER.y + FINGERSPELL_RIGHT_WRIST_OFFSET.y,
  )

  if (!hand?.length) {
    return { hand: null, wrist: baseWristTarget }
  }

  const sourceWrist = hand[0]
  const wristMotion = baseWrist
    ? {
        x: (sourceWrist.x - baseWrist.x) * FINGERSPELL_MOTION_PATH_SCALE,
        y: (sourceWrist.y - baseWrist.y) * FINGERSPELL_MOTION_PATH_SCALE,
        z: ((sourceWrist.z || 0) - (baseWrist.z || 0)) * FINGERSPELL_MOTION_PATH_SCALE,
      }
    : { x: 0, y: 0, z: 0 }
  const wristTarget = makePoint(
    baseWristTarget.x + wristMotion.x,
    baseWristTarget.y + wristMotion.y,
    wristMotion.z,
  )

  // Fingerspelling images have good local finger shapes, but their image-space
  // wrist location is unrelated to the avatar. Normalize every point around
  // landmark 0, scale that local shape, then anchor the wrist beside the right shoulder.
  // Motion letters pass a base wrist so J/Z keep a small version of the video
  // wrist path while the whole sign remains beside the avatar.
  const placedHand = hand.map((point) => ({
    x: wristTarget.x + (point.x - sourceWrist.x) * FINGERSPELL_HAND_SCALE,
    y: wristTarget.y + (point.y - sourceWrist.y) * FINGERSPELL_HAND_SCALE,
    z: point.z !== undefined ? (point.z - (sourceWrist.z || 0)) * FINGERSPELL_HAND_SCALE : undefined,
  }))

  return { hand: placedHand, wrist: wristTarget }
}

function normalizeFingerspellingLetterAnimation(data: SignData, letter: string): SignData {
  console.log("[renderer] sign type: fingerspell_letter, applying side placement")
  const firstHandFrame = data.frames.find((frame) => getPrimaryFingerspellHand(frame))
  const baseWrist = isFingerspellMotionLetter(data) && firstHandFrame
    ? getPrimaryFingerspellHand(firstHandFrame)?.[0]
    : null

  return {
    ...data,
    word: letter,
    source: "fingerspelling",
    frames: data.frames.map((frame) => {
      const { hand, wrist } = placeFingerspellHand(getPrimaryFingerspellHand(frame), baseWrist)

      return {
        // Fingerspelling uses one action hand only. We synthesize the right arm
        // so the hand is connected shoulder -> elbow -> wrist, while regular
        // WLASL frames continue to render their original pose and hand data.
        leftHand: null,
        rightHand: hand,
        pose: makeFingerspellPose(wrist),
      }
    }),
    metadata: {
      ...(data.metadata || {}),
      type: "fingerspell_letter",
      source: isFingerspellMotionLetter(data) ? "kaggle_asl_alphabet_video" : "kaggle_asl_alphabet",
      letter,
      isMotionLetter: isFingerspellMotionLetter(data),
    },
  }
}

async function loadSynonymMap(): Promise<Map<string, string>> {
  if (synonymMapCache.loaded) {
    return synonymMapCache.values
  }

  synonymMapCache.loaded = true

  const loadFromPath = async (filePath: string) => {
    const response = await fetch(filePath)
    if (!response.ok) {
      throw new Error(`${filePath} returned ${response.status}`)
    }

    const data = (await response.json()) as Record<string, unknown>
    Object.entries(data).forEach(([word, mappedWord]) => {
      if (typeof mappedWord !== "string") return
      const normalizedWord = normalizeGloss(word)
      const normalizedMappedWord = normalizeGloss(mappedWord)
      if (normalizedWord && normalizedMappedWord) {
        synonymMapCache.values.set(normalizedWord, normalizedMappedWord)
      }
    })
    console.log(`[word-resolution] synonym file path loaded: ${filePath}`)
    console.log(`[word-resolution] synonymEntryCount loaded: ${synonymMapCache.values.size}`)
  }

  try {
    await loadFromPath("/data/synonymMap.json")
  } catch (error) {
    console.warn("[word-resolution] unable to load generated synonymMap.json; trying manual fallback.", error)
    try {
      await loadFromPath("/data/manualSynonymMap.json")
    } catch (manualError) {
      console.warn("[word-resolution] unable to load manual synonym map; continuing to AI fallback.", manualError)
    }
  }

  return synonymMapCache.values
}

async function normalizeSentenceForSigning(input: string): Promise<string> {
  try {
    const response = await fetch("/api/normalize-sentence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input }),
    })

    if (!response.ok) {
      throw new Error(`Sentence normalization failed: ${response.status}`)
    }

    const data = (await response.json()) as { normalizedText?: unknown }
    const normalizedText = typeof data.normalizedText === "string" && data.normalizedText.trim()
      ? data.normalizedText
      : input
    return applyProtectedPhraseNormalizations(normalizedText)
  } catch (error) {
    console.warn("[word-resolution] sentence normalization unavailable; using original input.", error)
    return applyProtectedPhraseNormalizations(input)
  }
}

export async function loadSignDictionary(): Promise<{
  entries: SignDictionaryEntry[]
  source: "firebase" | "local"
}> {
  const loadLocalDictionary = async () => {
    const response = await fetch("/api/sign-dictionary")
    if (!response.ok) {
      throw new Error("Unable to load sign dictionary.")
    }
    const data = await response.json()
    const entries = (data.entries || []) as SignDictionaryEntry[]
    console.log(`[signDictionary] loaded local dictionary count: ${entries.length}`)
    ;["type", "word", "here"].forEach((word) => {
      const entry = entries.find((item) => entryKey(item.gloss) === word)
      console.log(`[signDictionary] local entry for ${word}: ${entry ? "found" : "missing"}`)
    })
    return {
      entries,
      source: "local" as const,
    }
  }

  const localDictionary = await loadLocalDictionary()
  console.log("[signDictionary] using local dictionary as source of truth")

  if (!USE_FIRESTORE_SIGNS) {
    console.log("[signDictionary] firestore signs disabled; set NEXT_PUBLIC_USE_FIRESTORE_SIGNS=true to enable optional metadata loading")
    return localDictionary
  }

  if (hasFirebaseConfig()) {
    const db = getFirebaseDb()
    if (db) {
      try {
        const snapshot = await getDocs(query(collection(db, "signs"), orderBy("gloss")))
        console.log(`[signDictionary] firestore signs count: ${snapshot.size}`)
        if (snapshot.empty) {
          console.warn("[signDictionary] Firestore signs collection is empty; continuing with local dictionary.")
          return localDictionary
        }

        const firestoreEntries = snapshot.docs.map((doc) => {
          const data = doc.data() as SignDictionaryEntry
          return {
            ...data,
            gloss: normalizeGloss(data.gloss || doc.id),
            aliases: data.aliases || [],
            available: Boolean(data.available),
          }
        })

        if (!firestoreEntries.some((entry) => entry.available)) {
          console.warn("[signDictionary] Firestore signs collection has no available signs; continuing with local dictionary.")
          return localDictionary
        }

        console.log("[signDictionary] Firestore signs loaded, but local dictionary remains source of truth.")
        return localDictionary
      } catch (error) {
        console.warn("[signDictionary] Firestore signs unavailable; continuing with local dictionary.", error)
        return localDictionary
      }
    }
  }

  console.warn("[signDictionary] Firebase unavailable for optional Firestore signs; continuing with local dictionary.")
  return localDictionary
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
        resolutionType: "exact",
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
  const resolverInput = await normalizeSentenceForSigning(input)
  const queue = parseSentenceToQueue(resolverInput, dictionary, showSkippedWords)
  queue
    .filter((item) => item.status === "available" && item.entry && item.resolutionType === "exact")
    .forEach((item) => logResolution(`Exact match: ${item.text} -> ${item.gloss}`))

  const availableEntries = dictionary.filter((entry) => entry.available)
  const entryLookup = new Map<string, SignDictionaryEntry>()
  availableEntries.forEach((entry) => {
    entryLookup.set(entry.gloss, entry)
  })

  const dictionaryWords = Array.from(entryLookup.keys())

  const synonymMap = await loadSynonymMap()
  const synonymReplacements: MissingWordReplacement[] = []
  const synonymResolvedQueue = queue.map((item) => {
    if (item.status !== "unavailable" || item.entry) return item

    const synonymWord = synonymMap.get(entryKey(item.text))
    const entry = synonymWord ? entryLookup.get(synonymWord) : undefined
    if (!synonymWord || !entry) return item

    const replacement: MissingWordReplacement = {
      originalWord: item.text,
      replacementWord: entry.gloss,
      confidence: "high",
      reason: "Local thesaurus synonym found in sign dictionary",
    }
    synonymReplacements.push(replacement)
    logResolution(`Synonym fallback: ${item.text} -> ${entry.gloss}`)

    return {
      ...item,
      gloss: entry.gloss,
      type: entry.type,
      status: "available" as const,
      entry,
      reason: replacement.reason,
      replacement,
      resolutionType: "synonym" as const,
    }
  })

  const missingWords = Array.from(
    new Set(
      synonymResolvedQueue
        .filter((item) => item.status === "unavailable" && !item.entry)
        .map((item) => item.text),
    ),
  )

  if (!missingWords.length) {
    return { queue: synonymResolvedQueue, replacements: synonymReplacements, unresolved: [], aiUnavailable: false }
  }

  try {
    if (!dictionaryWords.length) {
      throw new Error("No available dictionary words for AI fallback.")
    }

    const response = await fetch("/api/resolve-missing-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sentence: resolverInput,
        missingWords,
        dictionaryWords,
      }),
    })

    if (!response.ok) {
      throw new Error(`AI fallback request failed: ${response.status}`)
    }

    const data = (await response.json()) as {
      replacements?: MissingWordReplacement[]
      unresolved?: string[]
    }

    const replacements = (data.replacements || []).filter((replacement) =>
      entryLookup.has(replacement.replacementWord),
    )
    const replacementLookup = new Map(replacements.map((replacement) => [replacement.originalWord, replacement]))

    const resolvedQueue = synonymResolvedQueue.map((item) => {
      const replacement = replacementLookup.get(item.text)
      const entry = replacement ? entryLookup.get(replacement.replacementWord) : undefined
      if (!replacement || !entry) return item

      logResolution(`AI semantic fallback: ${item.text} -> ${entry.gloss}`)

      return {
        ...item,
        gloss: entry.gloss,
        type: entry.type,
        status: "available" as const,
        entry,
        reason: replacement.reason,
        replacement,
        resolutionType: "ai" as const,
      }
    })

    const resolvedWords = new Set(replacements.map((replacement) => replacement.originalWord))
    const unresolved = Array.from(
      new Set([...(data.unresolved || []), ...missingWords.filter((word) => !resolvedWords.has(word))]),
    )
    const fingerspelledQueue = applyFingerspellingFallback(resolvedQueue, unresolved)

    return {
      queue: fingerspelledQueue,
      replacements: [...synonymReplacements, ...replacements],
      unresolved: [],
      aiUnavailable: false,
    }
  } catch (error) {
    console.warn("[word-resolution] AI fallback unavailable; continuing to fingerspelling.", error)
    return {
      queue: applyFingerspellingFallback(synonymResolvedQueue, missingWords),
      replacements: synonymReplacements,
      unresolved: [],
      aiUnavailable: true,
    }
  }
}

function applyFingerspellingFallback(queue: PlaybackQueueItem[], unresolvedWords: string[]): PlaybackQueueItem[] {
  const unresolvedSet = new Set(unresolvedWords)

  return queue.map((item) => {
    if (!unresolvedSet.has(item.text) || item.status !== "unavailable") return item

    const letters = lettersForFingerspelling(item.text)
    logResolution(`Fingerspelling fallback: ${letters.join(" ") || "(no supported letters)"}`)

    return {
      ...item,
      gloss: item.text,
      type: "fingerspell" as const,
      status: letters.length ? ("available" as const) : ("unavailable" as const),
      reason: letters.length ? "Fingerspelled with ASL alphabet" : `No supported fingerspelling letters for ${item.text}`,
      resolutionType: "fingerspell" as const,
      fingerspellLetters: letters,
    }
  })
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
  if (!url && storage && entry.jsonPath && !entry.jsonPath.startsWith("/")) {
    url = await getDownloadURL(ref(storage, entry.jsonPath))
  }

  if (!url) {
    url = entry.jsonPath?.startsWith("/")
      ? entry.jsonPath
      : `/data/signs/${encodeURIComponent(entry.gloss.replace(/\s+/g, "_"))}.json`
  }

  console.log(`[signDictionary] loading sign path for ${entry.gloss}: ${url}`)
  const response = await fetch(url)
  console.log(`[signDictionary] sign file exists/loaded: ${response.ok}`)
  if (!response.ok) {
    throw new Error(`Unable to load animation for ${entry.gloss}.`)
  }

  const rawData = (await response.json()) as SignData
  const data = {
    ...rawData,
    word: rawData.word || entry.gloss,
    fps: rawData.fps || entry.fps || 30,
    source: "wlasl" as const,
  }
  if (!data.frames?.length) {
    throw new Error(`Animation file for ${entry.gloss} is empty or invalid.`)
  }

  logPlaybackSignDiagnostics(entry, url, data)
  console.log("[renderer] sign type: regular_sign, preserving original landmarks")
  const animation = correctThankYouLandmarks(data)
  animationCache.set(key, animation)
  return animation
}

export async function fetchFingerspellingAnimation(word: string, letters: string[]): Promise<SignData> {
  const key = `fingerspell:${word}:${letters.join("")}`
  const cached = animationCache.get(key)
  if (cached) {
    return cached
  }

  const frames: SignData["frames"] = []
  const wordTimeline: NonNullable<SignData["wordTimeline"]> = []
  const fps = FINGERSPELL_FPS
  const letterFrameCount = framesForDuration(FINGERSPELL_LETTER_DURATION_MS)
  const pauseFrames = framesForDuration(FINGERSPELL_LETTER_PAUSE_MS)
  const transitionFrames = framesForDuration(FINGERSPELL_TRANSITION_MS)

  for (const letter of letters) {
    try {
      const response = await fetch(`/data/fingerspelling/${letter}.json`)
      if (!response.ok) {
        console.warn(`[word-resolution] Missing fingerspelling JSON for ${letter}; skipping letter.`)
        continue
      }

      const data = normalizeFingerspellingLetterAnimation((await response.json()) as SignData, letter)
      if (!data.frames?.length) {
        console.warn(`[word-resolution] Empty fingerspelling JSON for ${letter}; skipping letter.`)
        continue
      }

      const durationFrameCount = isFingerspellMotionLetter(data)
        ? framesForDuration(FINGERSPELL_MOTION_LETTER_DURATION_MS)
        : letterFrameCount
      const letterFrames = stretchFramesToDuration(data.frames, durationFrameCount)
      const startFrame = frames.length
      if (frames.length && transitionFrames > 0) {
        const previousFrame = frames[frames.length - 1]
        const nextFrame = letterFrames[0]
        for (let index = 0; index < transitionFrames; index++) {
          frames.push(interpolateFrame(previousFrame, nextFrame, (index + 1) / (transitionFrames + 1)))
        }
      }

      // Hold each letter pose long enough to recognize it, then add a short
      // same-pose pause. The wrist anchor is identical for every letter, so the
      // arm stays attached and the fingers transition without canvas jumps.
      frames.push(...letterFrames)
      const lastFrame = frames[frames.length - 1]
      for (let index = 0; index < pauseFrames; index++) {
        frames.push(cloneFrame(lastFrame))
      }
      const endFrame = Math.max(startFrame, frames.length - 1)
      wordTimeline.push({
        word: letter,
        displayWord: letter,
        startFrame,
        endFrame,
      })
    } catch (error) {
      console.warn(`[word-resolution] Unable to load fingerspelling JSON for ${letter}; skipping letter.`, error)
    }
  }

  if (!frames.length) {
    throw new Error(`No fingerspelling frames available for ${word}.`)
  }

  const animation: SignData = {
    word,
    fps,
    frames,
    source: "fingerspelling",
    wordTimeline,
    metadata: {
      type: "fingerspell_word",
      letters,
    },
  }
  animationCache.set(key, animation)
  return animation
}
