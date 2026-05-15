import type { Frame, Landmark, SignData, WordTimelineItem } from "./types"

export type MotionConfidence = "low" | "medium" | "high"

export type SentenceAnimationOptions = {
  minThreshold: number
  thresholdMultiplier: number
  startBuffer: number
  endBuffer: number
  smoothingWindow: number
  transitionFrameCount: number
  minActiveFrames: number
  maxTrimPercent: number
  debug: boolean
}

export type MotionRange = {
  startIndex: number
  endIndex: number
  confidence: MotionConfidence
  averageMotion: number
  maxMotion: number
}

export type TrimResult = {
  frames: Frame[]
  startIndex: number
  endIndex: number
  originalFrameCount: number
  trimmedFrameCount: number
  trimApplied: boolean
  confidence: MotionConfidence
  averageMotion: number
  maxMotion: number
}

export type TransitionSummaryItem = {
  from: string
  to: string
  frameCount: number
  applied: boolean
}

export type SentenceAnimationResult = {
  frames: Frame[]
  wordsUsed: string[]
  missingWords: string[]
  totalFrames: number
  wordTimeline: WordTimelineItem[]
  trimSummary: Record<string, TrimResult>
  transitionSummary: TransitionSummaryItem[]
}

type FrameWithMouth = Frame & {
  mouth?: Landmark[] | null
  mouthLandmarks?: Landmark[] | null
  mouth_landmarks?: Landmark[] | null
}

type LandmarkGroup = {
  landmarks: Landmark[] | null
  weight: number
}

export const DEFAULT_SENTENCE_ANIMATION_OPTIONS: SentenceAnimationOptions = {
  minThreshold: 0.002,
  thresholdMultiplier: 0.6,
  startBuffer: 2,
  endBuffer: 3,
  smoothingWindow: 3,
  transitionFrameCount: 4,
  minActiveFrames: 5,
  maxTrimPercent: 0.35,
  debug: true,
}

function mergeOptions(options?: Partial<SentenceAnimationOptions>): SentenceAnimationOptions {
  return { ...DEFAULT_SENTENCE_ANIMATION_OPTIONS, ...options }
}

function isLandmark(point: Landmark | null | undefined): point is Landmark {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

function cloneLandmarks(landmarks: Landmark[] | null | undefined): Landmark[] | null {
  if (!landmarks) return null
  return landmarks.map((point) => ({ ...point }))
}

function cloneFrame(frame: Frame): Frame {
  const source = frame as FrameWithMouth
  return {
    ...frame,
    leftHand: cloneLandmarks(frame.leftHand),
    rightHand: cloneLandmarks(frame.rightHand),
    pose: cloneLandmarks(frame.pose),
    mouth: cloneLandmarks(source.mouth),
    mouthLandmarks: cloneLandmarks(source.mouthLandmarks),
    mouth_landmarks: cloneLandmarks(source.mouth_landmarks),
  } as Frame
}

function getMouthLandmarks(frame: Frame): Landmark[] | null {
  const source = frame as FrameWithMouth
  return source.mouthLandmarks || source.mouth_landmarks || source.mouth || null
}

function getPoseMotionLandmarks(frame: Frame): Landmark[] | null {
  if (!frame.pose?.length) return null
  const priorityIndices = [11, 12, 13, 14, 15, 16]
  const points = priorityIndices.map((index) => frame.pose?.[index]).filter(isLandmark)
  return points.length ? points : null
}

function compareLandmarkLists(a: Landmark[] | null, b: Landmark[] | null): number | null {
  if (!a || !b) return null
  const count = Math.min(a.length, b.length)
  if (!count) return null

  let total = 0
  let usable = 0
  for (let index = 0; index < count; index++) {
    const first = a[index]
    const second = b[index]
    if (!isLandmark(first) || !isLandmark(second)) continue
    total += Math.hypot(
      second.x - first.x,
      second.y - first.y,
      (second.z || 0) - (first.z || 0),
    )
    usable += 1
  }

  return usable ? total / usable : null
}

function getMotionScore(previousFrame: Frame, nextFrame: Frame): number {
  const groups: LandmarkGroup[] = [
    { landmarks: previousFrame.leftHand, weight: 1 },
    { landmarks: previousFrame.rightHand, weight: 1 },
    { landmarks: getMouthLandmarks(previousFrame), weight: 0.45 },
    { landmarks: getPoseMotionLandmarks(previousFrame), weight: 0.35 },
  ]
  const nextGroups: (Landmark[] | null)[] = [
    nextFrame.leftHand,
    nextFrame.rightHand,
    getMouthLandmarks(nextFrame),
    getPoseMotionLandmarks(nextFrame),
  ]

  let total = 0
  let weightTotal = 0
  groups.forEach((group, index) => {
    const score = compareLandmarkLists(group.landmarks, nextGroups[index])
    if (score === null) return
    total += score * group.weight
    weightTotal += group.weight
  })

  return weightTotal ? total / weightTotal : 0
}

function movingAverage(scores: number[], windowSize: number): number[] {
  const radius = Math.max(0, Math.floor(windowSize / 2))
  return scores.map((_, index) => {
    const start = Math.max(0, index - radius)
    const end = Math.min(scores.length - 1, index + radius)
    const slice = scores.slice(start, end + 1)
    return slice.reduce((sum, score) => sum + score, 0) / Math.max(1, slice.length)
  })
}

function confidenceForRange(activePairs: number, frameCount: number, averageMotion: number, maxMotion: number): MotionConfidence {
  if (activePairs <= 0 || maxMotion <= 0) return "low"
  const coverage = activePairs / Math.max(1, frameCount - 1)
  const peakRatio = maxMotion / Math.max(averageMotion, 0.000001)
  if (coverage >= 0.18 && peakRatio >= 1.35) return "high"
  if (coverage >= 0.1 && peakRatio >= 1.15) return "medium"
  return "low"
}

export function detectActiveMotionRange(
  frames: Frame[],
  options?: Partial<SentenceAnimationOptions>,
): MotionRange {
  const resolved = mergeOptions(options)
  if (frames.length <= 1) {
    return {
      startIndex: 0,
      endIndex: Math.max(0, frames.length - 1),
      confidence: "low",
      averageMotion: 0,
      maxMotion: 0,
    }
  }

  const rawScores = frames.slice(1).map((frame, index) => getMotionScore(frames[index], frame))
  const scores = movingAverage(rawScores, resolved.smoothingWindow)
  const averageMotion = scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length)
  const maxMotion = scores.reduce((max, score) => Math.max(max, score), 0)
  const threshold = Math.max(resolved.minThreshold, averageMotion * resolved.thresholdMultiplier)
  const activePairIndices = scores
    .map((score, index) => (score >= threshold ? index : -1))
    .filter((index) => index >= 0)

  if (!activePairIndices.length) {
    return {
      startIndex: 0,
      endIndex: frames.length - 1,
      confidence: "low",
      averageMotion,
      maxMotion,
    }
  }

  const firstActivePair = activePairIndices[0]
  const lastActivePair = activePairIndices[activePairIndices.length - 1]
  const startIndex = Math.max(0, firstActivePair - resolved.startBuffer)
  const endIndex = Math.min(frames.length - 1, lastActivePair + 1 + resolved.endBuffer)

  return {
    startIndex,
    endIndex,
    confidence: confidenceForRange(activePairIndices.length, frames.length, averageMotion, maxMotion),
    averageMotion,
    maxMotion,
  }
}

export function trimIdleFrames(
  frames: Frame[],
  options?: Partial<SentenceAnimationOptions>,
): TrimResult {
  const resolved = mergeOptions(options)
  const originalFrameCount = frames.length
  const range = detectActiveMotionRange(frames, resolved)
  const activeFrameCount = range.endIndex - range.startIndex + 1
  const startTrim = range.startIndex
  const endTrim = originalFrameCount - range.endIndex - 1
  const trimPercent = (startTrim + endTrim) / Math.max(1, originalFrameCount)
  const canTrim =
    range.confidence !== "low" &&
    activeFrameCount >= resolved.minActiveFrames &&
    trimPercent > 0 &&
    trimPercent <= resolved.maxTrimPercent

  if (!canTrim) {
    return {
      frames: frames.map(cloneFrame),
      startIndex: 0,
      endIndex: Math.max(0, originalFrameCount - 1),
      originalFrameCount,
      trimmedFrameCount: originalFrameCount,
      trimApplied: false,
      confidence: range.confidence,
      averageMotion: range.averageMotion,
      maxMotion: range.maxMotion,
    }
  }

  const trimmedFrames = frames.slice(range.startIndex, range.endIndex + 1).map(cloneFrame)
  return {
    frames: trimmedFrames,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    originalFrameCount,
    trimmedFrameCount: trimmedFrames.length,
    trimApplied: true,
    confidence: range.confidence,
    averageMotion: range.averageMotion,
    maxMotion: range.maxMotion,
  }
}

function interpolateLandmarkList(a: Landmark[] | null, b: Landmark[] | null, t: number): Landmark[] | null {
  if (!a && !b) return null
  if (!a || !b || a.length !== b.length) return null

  return a.map((point, index) => {
    const nextPoint = b[index]
    if (!isLandmark(point) || !isLandmark(nextPoint)) return { ...point }
    return {
      x: point.x + (nextPoint.x - point.x) * t,
      y: point.y + (nextPoint.y - point.y) * t,
      z: point.z !== undefined || nextPoint.z !== undefined
        ? (point.z || 0) + ((nextPoint.z || 0) - (point.z || 0)) * t
        : undefined,
    }
  })
}

function framesCompatible(a: Frame, b: Frame): boolean {
  const sourceA = a as FrameWithMouth
  const sourceB = b as FrameWithMouth
  const keys: (keyof FrameWithMouth)[] = ["leftHand", "rightHand", "pose", "mouth", "mouthLandmarks", "mouth_landmarks"]
  return keys.some((key) => {
    const first = sourceA[key] as Landmark[] | null | undefined
    const second = sourceB[key] as Landmark[] | null | undefined
    return Boolean(first && second && first.length === second.length)
  })
}

export function blendTransition(
  lastFrame: Frame,
  nextFrame: Frame,
  transitionFrameCount: number,
): Frame[] {
  if (transitionFrameCount <= 0 || !framesCompatible(lastFrame, nextFrame)) return []

  const a = lastFrame as FrameWithMouth
  const b = nextFrame as FrameWithMouth
  return Array.from({ length: transitionFrameCount }, (_, index) => {
    const t = (index + 1) / (transitionFrameCount + 1)
    return {
      ...cloneFrame(lastFrame),
      leftHand: interpolateLandmarkList(a.leftHand, b.leftHand, t) || cloneLandmarks(a.leftHand) || cloneLandmarks(b.leftHand),
      rightHand: interpolateLandmarkList(a.rightHand, b.rightHand, t) || cloneLandmarks(a.rightHand) || cloneLandmarks(b.rightHand),
      pose: interpolateLandmarkList(a.pose, b.pose, t) || cloneLandmarks(a.pose) || cloneLandmarks(b.pose),
      mouth: interpolateLandmarkList(a.mouth || null, b.mouth || null, t) || cloneLandmarks(a.mouth) || cloneLandmarks(b.mouth),
      mouthLandmarks:
        interpolateLandmarkList(a.mouthLandmarks || null, b.mouthLandmarks || null, t) ||
        cloneLandmarks(a.mouthLandmarks) ||
        cloneLandmarks(b.mouthLandmarks),
      mouth_landmarks:
        interpolateLandmarkList(a.mouth_landmarks || null, b.mouth_landmarks || null, t) ||
        cloneLandmarks(a.mouth_landmarks) ||
        cloneLandmarks(b.mouth_landmarks),
    } as Frame
  })
}

function logTrim(word: string, trim: TrimResult) {
  console.log(
    `[sentence-animation] ${word}: original=${trim.originalFrameCount}, ` +
      `active=${trim.startIndex}-${trim.endIndex}, trimmed=${trim.trimmedFrameCount}, ` +
      `trimApplied=${trim.trimApplied}, averageMotion=${trim.averageMotion.toFixed(5)}, ` +
      `maxMotion=${trim.maxMotion.toFixed(5)}, confidence=${trim.confidence}`,
  )
}

function toDisplayWord(word: string): string {
  return word
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function appendWordTimeline(
  wordTimeline: WordTimelineItem[],
  animation: SignData,
  word: string,
  startFrame: number,
  endFrame: number,
  trim: TrimResult,
) {
  if (animation.source === "fingerspelling" && animation.wordTimeline?.length) {
    animation.wordTimeline.forEach((item) => {
      const clippedStart = Math.max(item.startFrame, trim.startIndex)
      const clippedEnd = Math.min(item.endFrame, trim.endIndex)
      if (clippedEnd < clippedStart) return

      wordTimeline.push({
        word: item.word,
        // Fingerspelling animations carry an inner letter timeline. Preserve it
        // so the header can show G -> A -> U instead of one long "Gauri" label.
        displayWord: item.displayWord,
        startFrame: startFrame + clippedStart - trim.startIndex,
        endFrame: startFrame + clippedEnd - trim.startIndex,
      })
    })

    return
  }

  wordTimeline.push({
    word,
    displayWord: toDisplayWord(word),
    startFrame,
    endFrame,
  })
}

export function buildSentenceAnimation(
  words: string[],
  wordAnimationMap: Record<string, SignData | undefined> | Map<string, SignData>,
  options?: Partial<SentenceAnimationOptions>,
): SentenceAnimationResult {
  const resolved = mergeOptions(options)
  const frames: Frame[] = []
  const wordsUsed: string[] = []
  const missingWords: string[] = []
  const wordTimeline: WordTimelineItem[] = []
  const trimSummary: Record<string, TrimResult> = {}
  const transitionSummary: TransitionSummaryItem[] = []

  const lookup = (word: string) =>
    wordAnimationMap instanceof Map ? wordAnimationMap.get(word) : wordAnimationMap[word]

  words.forEach((word) => {
    const animation = lookup(word)
    if (!animation?.frames?.length) {
      missingWords.push(word)
      return
    }

    const trim = animation.source === "fingerspelling"
      ? {
          frames: animation.frames.map(cloneFrame),
          startIndex: 0,
          endIndex: Math.max(0, animation.frames.length - 1),
          originalFrameCount: animation.frames.length,
          trimmedFrameCount: animation.frames.length,
          trimApplied: false,
          confidence: "low" as const,
          averageMotion: 0,
          maxMotion: 0,
        }
      : trimIdleFrames(animation.frames, resolved)
    trimSummary[word] = trim
    if (resolved.debug) logTrim(word, trim)

    if (frames.length && trim.frames.length) {
      const previousWord = wordsUsed[wordsUsed.length - 1] || ""
      const transitionFrames = blendTransition(
        frames[frames.length - 1],
        trim.frames[0],
        resolved.transitionFrameCount,
      )
      frames.push(...transitionFrames)
      const previousTimelineItem = wordTimeline[wordTimeline.length - 1]
      if (previousTimelineItem && transitionFrames.length) {
        previousTimelineItem.endFrame += transitionFrames.length
      }
      transitionSummary.push({
        from: previousWord,
        to: word,
        frameCount: transitionFrames.length,
        applied: transitionFrames.length > 0,
      })
    }

    const startFrame = frames.length
    frames.push(...trim.frames.map(cloneFrame))
    appendWordTimeline(wordTimeline, animation, word, startFrame, Math.max(startFrame, frames.length - 1), trim)
    wordsUsed.push(word)
  })

  return {
    frames,
    wordsUsed,
    missingWords,
    totalFrames: frames.length,
    wordTimeline,
    trimSummary,
    transitionSummary,
  }
}
