"use client"

import { useRef, useEffect, useCallback, useState, type MutableRefObject } from "react"
import { motion } from "framer-motion"
import {
  FIXED_FACE_TEMPLATE,
  type FaceTemplate,
} from "@/lib/avatar/faceTemplate"
import type { SignData, Frame, Landmark } from "@/lib/types"

interface AvatarCanvasProps {
  signData: SignData | null
  isPlaying: boolean
  onPlaybackComplete?: () => void
  onFrameChange?: (frameIndex: number) => void
  showIdle?: boolean
}

type CanvasPoint = { x: number; y: number }
type Bounds = { minX: number; minY: number; maxX: number; maxY: number }
type MouthMetadata = {
  mouthFramesDetected?: number
  mouthFramesInterpolated?: number
  mouthFramesMissing?: number
  mouthMovementScore?: number
}
type FrameWithMouth = Frame & {
  mouth?: Landmark[] | null
  mouthLandmarks?: Landmark[] | null
  mouth_landmarks?: Landmark[] | null
}
type RendererSignType = "fingerspell_letter" | "regular_sign"
export type MouthState = "closed" | "smallOpen" | "ahOpen" | "ohRound" | "eeWide" | "lipsClosed" | "smile"
type MouthPose = { state: MouthState; intensity: number }

const FINGER_SEGMENTS = [
  { start: 1, joints: [2, 3, 4], color: "#e74c3c" },
  { start: 5, joints: [6, 7, 8], color: "#3498db" },
  { start: 9, joints: [10, 11, 12], color: "#2ecc71" },
  { start: 13, joints: [14, 15, 16], color: "#f39c12" },
  { start: 17, joints: [18, 19, 20], color: "#9b59b6" },
]

const DEFAULT_MOUTH_PLAN: MouthState[] = ["closed", "smallOpen", "closed"]
const CLOSED_MOUTH_POSE: MouthPose = { state: "closed", intensity: 0 }
const SPECIAL_MOUTH_PLANS: Record<string, MouthState[]> = {
  happy: ["closed", "ahOpen", "lipsClosed", "eeWide", "smile", "closed"],
  hello: ["closed", "smallOpen", "eeWide", "ohRound", "closed"],
  computer: ["closed", "smallOpen", "lipsClosed", "smallOpen", "eeWide", "closed"],
  drink: ["closed", "smallOpen", "closed"],
  book: ["closed", "lipsClosed", "ohRound", "closed"],
  thank: ["closed", "smallOpen", "closed"],
  sorry: ["closed", "ohRound", "eeWide", "closed"],
  yes: ["closed", "eeWide", "smile", "closed"],
  no: ["closed", "ohRound", "closed"],
}

const MOUTH_LANDMARK_INDICES = [
  0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91,
  95, 146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311,
  312, 314, 317, 318, 321, 324, 375, 402, 405, 409, 415,
]
const MOUTH_INDEX_TO_LOCAL = new Map(MOUTH_LANDMARK_INDICES.map((index, localIndex) => [index, localIndex]))
const OUTER_LIP_BOUNDARY = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95]
const INNER_LIP_BOUNDARY = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95]
const MOUTH_BOUNDARY_SMOOTHING = 0.68
const MOUTH_SCALE_X = 1.8
const MOUTH_SCALE_Y = 1.6
const MOUTH_MOVEMENT_AMPLIFY = 1.5
const MOUTH_MIN_WIDTH = 12
const MOUTH_MIN_HEIGHT = 6
const MOUTH_MAX_WIDTH_RATIO = 0.62
const MOUTH_MAX_HEIGHT_RATIO = 0.34

function generateDemoFrames(frameCount = 60): Frame[] {
  return Array.from({ length: frameCount }, (_, i) => {
    const t = i / frameCount
    const waveOffset = Math.sin(t * Math.PI * 2) * 0.1

    return {
      leftHand: null,
      rightHand: null,
      pose: [
        ...Array(11).fill({ x: 0.5, y: 0.2 }),
        { x: 0.38, y: 0.35 },
        { x: 0.62, y: 0.35 },
        { x: 0.28, y: 0.5 },
        { x: 0.72, y: 0.4 - waveOffset * 0.5 },
        { x: 0.22, y: 0.65 },
        { x: 0.78 + waveOffset * 0.2, y: 0.28 - waveOffset },
      ],
    }
  })
}

function isLandmark(point: Landmark | null | undefined): point is Landmark {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

function collectLandmarks(frame: Frame | null): Landmark[] {
  if (!frame) return []
  return [
    ...(frame.pose || []),
    ...(frame.leftHand || []),
    ...(frame.rightHand || []),
  ].filter(isLandmark)
}

function getRendererSignType(signData: SignData | null): RendererSignType {
  if (!signData) return "regular_sign"

  const metadata = signData.metadata || {}
  const metadataType = typeof metadata.type === "string" ? metadata.type : ""
  const metadataSource = typeof metadata.source === "string" ? metadata.source : ""
  const fingerspelledWords = metadata.fingerspelledWords

  if (
    signData.source === "fingerspelling" ||
    metadataType === "fingerspell_letter" ||
    metadataType === "fingerspell_word" ||
    metadataSource.includes("kaggle_asl_alphabet") ||
    (Array.isArray(fingerspelledWords) && fingerspelledWords.length > 0)
  ) {
    return "fingerspell_letter"
  }

  return "regular_sign"
}

function computeBounds(points: Landmark[]): Bounds | null {
  if (points.length === 0) return null
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  )
}

function mapLandmarks(
  landmarks: Landmark[] | null,
  transform: (point: Landmark) => CanvasPoint,
): (CanvasPoint | null)[] {
  return (landmarks || []).map((point) => (isLandmark(point) ? transform(point) : null))
}

function drawDot(ctx: CanvasRenderingContext2D, point: CanvasPoint, radius: number, color: string) {
  ctx.beginPath()
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  a: CanvasPoint | null,
  b: CanvasPoint | null,
  color: string,
  width = 3,
) {
  if (!a || !b) return
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.stroke()
}

function pointBetween(a: CanvasPoint, b: CanvasPoint, t: number): CanvasPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function normalizeMouthWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z]+/g, "")
}

function dedupeMouthPlan(plan: MouthState[]): MouthState[] {
  return plan.filter((state, index) => index === 0 || state !== plan[index - 1])
}

export function getMouthPlanForWord(word: string): MouthState[] {
  const normalized = normalizeMouthWord(word)
  if (!normalized) return DEFAULT_MOUTH_PLAN
  if (SPECIAL_MOUTH_PLANS[normalized]) return SPECIAL_MOUTH_PLANS[normalized]

  const plan: MouthState[] = ["closed"]
  const addState = (state: MouthState) => {
    if (plan.length < 4 && plan[plan.length - 1] !== state) plan.push(state)
  }

  if (/a|ha|ah/.test(normalized)) addState("ahOpen")
  if (/[pbm]/.test(normalized)) addState("lipsClosed")
  if (/oo|[ou]/.test(normalized)) addState("ohRound")
  if (/ee|[eiy]/.test(normalized)) addState("eeWide")

  if (plan.length === 1) addState("smallOpen")
  plan.push("closed")
  return dedupeMouthPlan(plan).slice(0, 5)
}

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * Math.min(1, Math.max(0, t))) - 1) / 2
}

export function getMouthStateAtProgress(word: string, progress: number): MouthState {
  const plan = getMouthPlanForWord(word)
  if (progress <= 0 || progress >= 1) return "closed"
  const stateIndex = Math.min(plan.length - 1, Math.floor(Math.min(0.999, Math.max(0, progress)) * plan.length))
  return plan[stateIndex] || "closed"
}

function getMouthPoseAtProgress(word: string, progress: number): MouthPose {
  const plan = getMouthPlanForWord(word)
  if (progress <= 0 || progress >= 1) return { state: "closed", intensity: 0 }

  const clampedProgress = Math.min(0.999, Math.max(0, progress))
  const rawIndex = clampedProgress * plan.length
  const stateIndex = Math.min(plan.length - 1, Math.floor(rawIndex))
  const localProgress = rawIndex - stateIndex
  const fadeIn = easeInOutSine(Math.min(localProgress * 3, 1))
  const fadeOut = easeInOutSine(Math.min((1 - localProgress) * 3, 1))
  const intensity = plan[stateIndex] === "closed" ? 0 : Math.min(fadeIn, fadeOut)

  return {
    state: plan[stateIndex] || "closed",
    intensity,
  }
}

function drawDesignedMouth(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  state: MouthState,
  size: number,
  intensity = 1,
) {
  ctx.save()
  ctx.strokeStyle = "#333333"
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.lineWidth = Math.max(1.6, Math.min(2.4, size * 0.06))
  const amount = Math.min(1, Math.max(0, intensity))
  const mouthWidth = size * (0.22 + amount * 0.16)
  const smallHeight = size * (0.04 + amount * 0.11)

  if (state === "smallOpen") {
    ctx.beginPath()
    ctx.ellipse(x, y, size * (0.12 + amount * 0.05), smallHeight, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (state === "ahOpen") {
    ctx.beginPath()
    ctx.ellipse(x, y, size * (0.15 + amount * 0.06), size * (0.11 + amount * 0.2), 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (state === "ohRound") {
    ctx.beginPath()
    ctx.ellipse(x, y, size * (0.12 + amount * 0.08), size * (0.1 + amount * 0.13), 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (state === "eeWide") {
    ctx.beginPath()
    ctx.ellipse(x, y, mouthWidth, size * (0.035 + amount * 0.045), 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (state === "lipsClosed") {
    ctx.beginPath()
    ctx.moveTo(x - mouthWidth, y)
    ctx.quadraticCurveTo(x, y - size * 0.025 * amount, x + mouthWidth, y)
    ctx.moveTo(x - mouthWidth * 0.82, y + size * 0.035)
    ctx.quadraticCurveTo(x, y + size * 0.055, x + mouthWidth * 0.82, y + size * 0.035)
    ctx.stroke()
  } else if (state === "smile") {
    ctx.beginPath()
    ctx.arc(x, y - size * (0.1 + amount * 0.04), size * (0.24 + amount * 0.08), 0.18 * Math.PI, 0.82 * Math.PI)
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.moveTo(x - size * 0.22, y)
    ctx.lineTo(x + size * 0.22, y)
    ctx.stroke()
  }

  ctx.restore()
}

function getMouthLandmarks(frame: Frame | null): Landmark[] | null {
  const frameWithMouth = frame as FrameWithMouth | null
  return frameWithMouth?.mouthLandmarks || frameWithMouth?.mouth_landmarks || frameWithMouth?.mouth || null
}

function getMouthBoundaryPoints(mouth: Landmark[], indices: number[]): Landmark[] {
  return indices
    .map((landmarkIndex) => {
      const localIndex = MOUTH_INDEX_TO_LOCAL.get(landmarkIndex)
      return localIndex === undefined ? null : mouth[localIndex]
    })
    .filter(isLandmark)
}

function getCanvasPointBounds(points: CanvasPoint[]): Bounds | null {
  if (points.length === 0) return null
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  )
}

function smoothMouthBoundary(previous: CanvasPoint[] | null, current: CanvasPoint[]): CanvasPoint[] {
  if (!previous || previous.length !== current.length) return current
  return current.map((point, index) => ({
    x: previous[index].x * MOUTH_BOUNDARY_SMOOTHING + point.x * (1 - MOUTH_BOUNDARY_SMOOTHING),
    y: previous[index].y * MOUTH_BOUNDARY_SMOOTHING + point.y * (1 - MOUTH_BOUNDARY_SMOOTHING),
  }))
}

function drawSmoothBoundary(ctx: CanvasRenderingContext2D, points: CanvasPoint[]) {
  if (points.length < 3) return
  ctx.beginPath()
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length]
    const mid = {
      x: (point.x + next.x) / 2,
      y: (point.y + next.y) / 2,
    }
    if (index === 0) ctx.moveTo(mid.x, mid.y)
    ctx.quadraticCurveTo(next.x, next.y, mid.x, mid.y)
  })
  ctx.closePath()
  ctx.stroke()
}

function normalizeLipBoundary(
  mouth: Landmark[],
  faceAnchor: { mouthCenter: CanvasPoint; headRadius: number },
  movementScore = 0,
): { outer: CanvasPoint[]; inner: CanvasPoint[]; openness: number } | null {
  const usableMouth = mouth.filter(isLandmark)
  const outerLandmarks = getMouthBoundaryPoints(mouth, OUTER_LIP_BOUNDARY)
  const innerLandmarks = getMouthBoundaryPoints(mouth, INNER_LIP_BOUNDARY)
  if (usableMouth.length < 12 || outerLandmarks.length < 12) return null

  const xs = usableMouth.map((point) => point.x)
  const ys = usableMouth.map((point) => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const rawWidth = maxX - minX
  const rawHeight = maxY - minY
  if (rawWidth <= 0.0001 || rawHeight <= 0.0001) return null

  const rawCenterX = (minX + maxX) / 2
  const rawCenterY = (minY + maxY) / 2
  const targetWidth = Math.min(
    faceAnchor.headRadius * MOUTH_MAX_WIDTH_RATIO,
    Math.max(MOUTH_MIN_WIDTH, faceAnchor.headRadius * rawWidth * 3.8),
  )
  const targetHeight = Math.min(
    faceAnchor.headRadius * MOUTH_MAX_HEIGHT_RATIO,
    Math.max(MOUTH_MIN_HEIGHT, faceAnchor.headRadius * rawHeight * 3.2),
  )
  const amplify = movementScore > 0.18 ? 1 : MOUTH_MOVEMENT_AMPLIFY

  const normalizePoint = (point: Landmark): CanvasPoint => ({
    x: faceAnchor.mouthCenter.x + ((point.x - rawCenterX) / rawWidth) * targetWidth * MOUTH_SCALE_X * amplify,
    y: faceAnchor.mouthCenter.y + ((point.y - rawCenterY) / rawHeight) * targetHeight * MOUTH_SCALE_Y * amplify,
  })

  const outer = outerLandmarks.map(normalizePoint)
  const inner = innerLandmarks.map(normalizePoint)
  const bounds = getCanvasPointBounds(outer)
  if (!bounds) return null

  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const maxWidth = faceAnchor.headRadius * MOUTH_MAX_WIDTH_RATIO
  const maxHeight = faceAnchor.headRadius * MOUTH_MAX_HEIGHT_RATIO
  const clampScale = Math.min(maxWidth / Math.max(width, 0.001), maxHeight / Math.max(height, 0.001), 1)
  if (clampScale < 1) {
    const center = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    }
    return {
      outer: outer.map((point) => ({
        x: center.x + (point.x - center.x) * clampScale,
        y: center.y + (point.y - center.y) * clampScale,
      })),
      inner: inner.map((point) => ({
        x: center.x + (point.x - center.x) * clampScale,
        y: center.y + (point.y - center.y) * clampScale,
      })),
      openness: rawHeight / rawWidth,
    }
  }

  return { outer, inner, openness: rawHeight / rawWidth }
}

function drawMouthFromLipLandmarks(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[] | null,
  faceAnchor: { mouthCenter: CanvasPoint; headRadius: number },
  previousBoundaryRef: MutableRefObject<{ outer: CanvasPoint[] | null; inner: CanvasPoint[] | null }>,
  movementScore = 0,
): boolean {
  if (!landmarks) return false
  const normalized = normalizeLipBoundary(landmarks, faceAnchor, movementScore)
  if (!normalized) return false

  const outer = smoothMouthBoundary(previousBoundaryRef.current.outer, normalized.outer)
  const inner = smoothMouthBoundary(previousBoundaryRef.current.inner, normalized.inner)
  previousBoundaryRef.current = { outer, inner }

  ctx.save()
  ctx.strokeStyle = "#333333"
  ctx.lineWidth = Math.max(2, Math.min(2.5, faceAnchor.headRadius * 0.055))
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  drawSmoothBoundary(ctx, outer)
  if (normalized.openness > 0.32 && inner.length >= 8) {
    ctx.lineWidth = Math.max(1.4, Math.min(2, faceAnchor.headRadius * 0.035))
    drawSmoothBoundary(ctx, inner)
  }
  ctx.restore()
  return true
}

function drawFixedFaceTemplate(
  ctx: CanvasRenderingContext2D,
  template: FaceTemplate,
  headCenter: CanvasPoint,
  headRadius: number,
) {
  ctx.save()
  ctx.strokeStyle = "#333333"
  ctx.fillStyle = "#333333"
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  template.strokes.forEach((stroke) => {
    const [firstPoint, ...rest] = stroke.points
    if (!firstPoint) return
    ctx.beginPath()
    ctx.moveTo(headCenter.x + firstPoint.x * headRadius, headCenter.y + firstPoint.y * headRadius)
    rest.forEach((point) => {
      ctx.lineTo(headCenter.x + point.x * headRadius, headCenter.y + point.y * headRadius)
    })
    if (stroke.closed) ctx.closePath()
    ctx.lineWidth = Math.max(1, headRadius * (stroke.width || 0.03))
    ctx.stroke()
  })

  template.dots.forEach((dot) => {
    drawDot(
      ctx,
      {
        x: headCenter.x + dot.center.x * headRadius,
        y: headCenter.y + dot.center.y * headRadius,
      },
      Math.max(1, dot.radius * headRadius),
      "#333333",
    )
  })

  ctx.restore()
}

export function AvatarCanvas({
  signData,
  isPlaying,
  onPlaybackComplete,
  onFrameChange,
  showIdle = true,
}: AvatarCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number | null>(null)
  const frameIndexRef = useRef(0)
  const lastFrameTimeRef = useRef(0)
  const idleOffsetRef = useRef(0)
  const faceTemplateRef = useRef<FaceTemplate>(FIXED_FACE_TEMPLATE)
  const previousMouthBoundaryRef = useRef<{ outer: CanvasPoint[] | null; inner: CanvasPoint[] | null }>({
    outer: null,
    inner: null,
  })
  const lastMouthDebugRef = useRef<string | null>(null)
  const lastRendererDebugRef = useRef<string | null>(null)
  const [, setCurrentFrame] = useState(0)
  const demoFrames = useRef(generateDemoFrames())

  useEffect(() => {
    frameIndexRef.current = 0
    lastFrameTimeRef.current = 0
    previousMouthBoundaryRef.current = { outer: null, inner: null }
    setCurrentFrame(0)
    onFrameChange?.(0)
  }, [onFrameChange, signData])

  useEffect(() => {
    if (!signData) return
    const rendererSignType = getRendererSignType(signData)
    const rendererDebugSignature = `${signData.word}:${signData.source || "unknown"}:${rendererSignType}`
    if (lastRendererDebugRef.current !== rendererDebugSignature) {
      console.log(
        rendererSignType === "fingerspell_letter"
          ? "[renderer] sign type: fingerspell_letter, applying side placement"
          : "[renderer] sign type: regular_sign, preserving original landmarks",
      )
      lastRendererDebugRef.current = rendererDebugSignature
    }

    const mouthMeta = signData as SignData & MouthMetadata & { hasMouth?: boolean; metadata?: MouthMetadata }
    const framesWithMouth = signData.frames.filter((frame) => {
      const mouth = getMouthLandmarks(frame)
      return Array.isArray(mouth) && mouth.length > 0
    }).length
    console.log("[mouth-debug]", {
      word: signData.word,
      hasMouthLandmarks: Boolean(mouthMeta.hasMouth || framesWithMouth > 0),
      mouthFramesDetected: mouthMeta.mouthFramesDetected ?? mouthMeta.metadata?.mouthFramesDetected ?? framesWithMouth,
      mouthMovementScore: mouthMeta.mouthMovementScore ?? mouthMeta.metadata?.mouthMovementScore ?? 0,
      renderingMode: framesWithMouth > 0 ? "video_mouth" : "fallback_closed",
    })
    lastMouthDebugRef.current = null
  }, [signData])

  const interpolateFrames = useCallback((frame1: Frame, frame2: Frame, t: number): FrameWithMouth => {
    const interpolateLandmarks = (
      l1: Landmark[] | null,
      l2: Landmark[] | null,
    ): Landmark[] | null => {
      if (!l1 || !l2) return l1 || l2
      return l1.map((p1, i) => {
        const p2 = l2[i]
        if (!isLandmark(p1) || !isLandmark(p2)) return p1
        return {
          x: p1.x + (p2.x - p1.x) * t,
          y: p1.y + (p2.y - p1.y) * t,
          z: p1.z !== undefined && p2.z !== undefined ? p1.z + (p2.z - p1.z) * t : undefined,
        }
      })
    }

    const frame1WithMouth = frame1 as FrameWithMouth
    const frame2WithMouth = frame2 as FrameWithMouth

    return {
      leftHand: interpolateLandmarks(frame1.leftHand, frame2.leftHand),
      rightHand: interpolateLandmarks(frame1.rightHand, frame2.rightHand),
      pose: interpolateLandmarks(frame1.pose, frame2.pose),
      mouth: interpolateLandmarks(frame1WithMouth.mouth || null, frame2WithMouth.mouth || null),
      mouthLandmarks: interpolateLandmarks(frame1WithMouth.mouthLandmarks || null, frame2WithMouth.mouthLandmarks || null),
      mouth_landmarks: interpolateLandmarks(frame1WithMouth.mouth_landmarks || null, frame2WithMouth.mouth_landmarks || null),
    }
  }, [])

  const drawHand = useCallback((
    ctx: CanvasRenderingContext2D,
    points: (CanvasPoint | null)[],
    poseWrist: CanvasPoint | null,
    isLeft: boolean,
  ) => {
    const wrist = points[0]
    const palmColor = isLeft ? "#2ecc71" : "#3498db"

    drawLine(ctx, poseWrist, wrist, "#d64545", 3)

    if (points.length < 21 || !wrist) {
      if (poseWrist) drawDot(ctx, poseWrist, 5, palmColor)
      return
    }

    ;[[0, 1], [0, 5], [0, 9], [0, 13], [0, 17], [5, 9], [9, 13], [13, 17]].forEach(([start, end]) => {
      drawLine(ctx, points[start], points[end], palmColor, 4)
    })

    FINGER_SEGMENTS.forEach(({ start, joints, color }) => {
      const startPoint = points[start]
      if (!startPoint) return
      let previous = startPoint
      joints.forEach((jointIdx) => {
        const joint = points[jointIdx]
        if (!joint) return
        drawLine(ctx, previous, joint, color, 4)
        previous = joint
      })
    })

    drawDot(ctx, wrist, 4, palmColor)
  }, [])

  const drawAvatar = useCallback((
    ctx: CanvasRenderingContext2D,
    frame: Frame | null,
    width: number,
    height: number,
    idleOffset: number,
    mouthPose: MouthPose,
  ) => {
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, width, height)

    const poseLandmarks = (frame?.pose || []).filter(isLandmark)
    const points = collectLandmarks(frame)
    const bounds = computeBounds(points)
    if (!frame || !bounds) return

    const floatY = Math.sin(idleOffset * 0.02) * 2
    const sourceFitBounds = { ...bounds }
    const sourceLeftShoulder = poseLandmarks[11]
    const sourceRightShoulder = poseLandmarks[12]
    if (sourceLeftShoulder && sourceRightShoulder) {
      const sourceShoulderDistance = Math.hypot(
        sourceRightShoulder.x - sourceLeftShoulder.x,
        sourceRightShoulder.y - sourceLeftShoulder.y,
      )
      const sourceShoulderCenter = pointBetween(sourceLeftShoulder, sourceRightShoulder, 0.5)
      const sourceHeadRadius = sourceShoulderDistance * 0.42
      const sourceHeadCenterY = sourceShoulderCenter.y - sourceShoulderDistance * 0.85
      sourceFitBounds.minX = Math.min(sourceFitBounds.minX, sourceShoulderCenter.x - sourceHeadRadius)
      sourceFitBounds.maxX = Math.max(sourceFitBounds.maxX, sourceShoulderCenter.x + sourceHeadRadius)
      sourceFitBounds.minY = Math.min(sourceFitBounds.minY, sourceHeadCenterY - sourceHeadRadius)
      sourceFitBounds.maxY = Math.max(sourceFitBounds.maxY, sourceHeadCenterY + sourceHeadRadius)
    }

    const paddingX = 44
    const paddingTop = 74
    const paddingBottom = 42
    const drawableWidth = width - paddingX * 2
    const drawableHeight = height - paddingTop - paddingBottom
    const sourceWidth = Math.max(sourceFitBounds.maxX - sourceFitBounds.minX, 0.12)
    const sourceHeight = Math.max(sourceFitBounds.maxY - sourceFitBounds.minY, 0.12)
    const scale = Math.min(drawableWidth / sourceWidth, drawableHeight / sourceHeight)
    const drawLeft = paddingX + Math.max(0, (drawableWidth - sourceWidth * scale) / 2)

    const transform = (point: Landmark): CanvasPoint => ({
      x: drawLeft + (point.x - sourceFitBounds.minX) * scale,
      y: paddingTop + (point.y - sourceFitBounds.minY) * scale + floatY,
    })

    const pose = mapLandmarks(frame.pose, transform)
    const leftHand = mapLandmarks(frame.leftHand, transform)
    const rightHand = mapLandmarks(frame.rightHand, transform)

    const leftShoulder = pose[11]
    const rightShoulder = pose[12]
    const leftElbow = pose[13]
    const rightElbow = pose[14]
    const leftWrist = pose[15]
    const rightWrist = pose[16]

    const hasShoulders = Boolean(leftShoulder && rightShoulder)
    const shoulderDistance = hasShoulders
      ? Math.hypot(rightShoulder!.x - leftShoulder!.x, rightShoulder!.y - leftShoulder!.y)
      : Math.min(width, height) * 0.24
    const shoulderCenter = hasShoulders
      ? pointBetween(leftShoulder!, rightShoulder!, 0.5)
      : { x: width / 2, y: paddingTop + drawableHeight / 2 + floatY + shoulderDistance * 0.2 }
    const headCenter = { x: shoulderCenter.x, y: shoulderCenter.y - shoulderDistance * 0.85 }
    const headRadius = Math.max(28, Math.min(58, shoulderDistance * 0.38))
    const outlineColor = "#d64545"

    ctx.save()
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    drawFixedFaceTemplate(ctx, faceTemplateRef.current, headCenter, headRadius)
    const mouthCenter = { x: headCenter.x, y: headCenter.y + headRadius * 0.45 }
    const mouthMeta = signData as (SignData & MouthMetadata & { metadata?: MouthMetadata }) | null
    const mouthMovementScore = mouthMeta?.mouthMovementScore ?? mouthMeta?.metadata?.mouthMovementScore ?? 0
    const drewLipMouth = drawMouthFromLipLandmarks(
      ctx,
      getMouthLandmarks(frame),
      { mouthCenter, headRadius },
      previousMouthBoundaryRef,
      mouthMovementScore,
    )
    const renderingMode = drewLipMouth
      ? mouthMovementScore > 0 ? "video_mouth" : "interpolated_mouth"
      : "fallback_closed"
    const debugSignature = signData ? `${signData.word}:${renderingMode}:${mouthMovementScore}` : null
    if (debugSignature && lastMouthDebugRef.current !== debugSignature) {
      console.log("[mouth-debug]", {
        word: signData?.word,
        hasMouthLandmarks: Boolean(getMouthLandmarks(frame)),
        mouthFramesDetected: mouthMeta?.mouthFramesDetected ?? mouthMeta?.metadata?.mouthFramesDetected ?? 0,
        mouthMovementScore,
        renderingMode,
      })
      lastMouthDebugRef.current = debugSignature
    }
    if (!drewLipMouth) {
      previousMouthBoundaryRef.current = { outer: null, inner: null }
      drawDesignedMouth(ctx, mouthCenter.x, mouthCenter.y, "closed", headRadius, 0)
    }

    drawLine(ctx, { x: headCenter.x, y: headCenter.y + headRadius }, shoulderCenter, outlineColor, 3)
    drawLine(ctx, leftShoulder, rightShoulder, outlineColor, 3)
    drawLine(ctx, leftShoulder, leftElbow, outlineColor, 3)
    drawLine(ctx, leftElbow, leftWrist, outlineColor, 3)
    drawLine(ctx, rightShoulder, rightElbow, outlineColor, 3)
    drawLine(ctx, rightElbow, rightWrist, outlineColor, 3)

    const hipCenter = { x: shoulderCenter.x, y: shoulderCenter.y + shoulderDistance * 1.18 }
    const leftHip = { x: shoulderCenter.x - shoulderDistance * 0.32, y: hipCenter.y }
    const rightHip = { x: shoulderCenter.x + shoulderDistance * 0.32, y: hipCenter.y }

    drawLine(ctx, leftShoulder, rightHip, outlineColor, 3)
    drawLine(ctx, rightShoulder, leftHip, outlineColor, 3)
    drawLine(ctx, leftHip, hipCenter, outlineColor, 3)
    drawLine(ctx, hipCenter, rightHip, outlineColor, 3)

    drawHand(ctx, leftHand, leftWrist || null, true)
    drawHand(ctx, rightHand, rightWrist || null, false)

    ctx.restore()
  }, [drawHand, signData])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const canvasWidth = 500
    const canvasHeight = 500
    canvas.width = canvasWidth
    canvas.height = canvasHeight
    canvas.style.width = `${canvasWidth}px`
    canvas.style.height = `${canvasHeight}px`

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const hasValidSignData = signData && signData.frames && signData.frames.length > 0
    const framesToUse = hasValidSignData ? signData.frames : demoFrames.current
    const fps = hasValidSignData ? signData.fps : 30

    const animate = (timestamp: number) => {
      idleOffsetRef.current += 1

      const shouldAnimate = hasValidSignData ? isPlaying : showIdle

      if (shouldAnimate) {
        const frameDuration = 1000 / fps

        if (timestamp - lastFrameTimeRef.current >= frameDuration) {
          frameIndexRef.current++
          lastFrameTimeRef.current = timestamp

          if (frameIndexRef.current >= framesToUse.length) {
            frameIndexRef.current = 0
            if (hasValidSignData) onPlaybackComplete?.()
          }

          setCurrentFrame(frameIndexRef.current)
          onFrameChange?.(frameIndexRef.current)
        }

        const currentIdx = frameIndexRef.current
        const nextIdx = hasValidSignData
          ? Math.min(currentIdx + 1, framesToUse.length - 1)
          : (currentIdx + 1) % framesToUse.length
        const progress = (timestamp - lastFrameTimeRef.current) / frameDuration
        const currentFrameData = framesToUse[currentIdx]
        const nextFrameData = framesToUse[nextIdx]
        const mouthProgress = hasValidSignData ? currentIdx / Math.max(1, framesToUse.length - 1) : 0
        const mouthPose = hasValidSignData
          ? getMouthPoseAtProgress(signData.word, mouthProgress)
          : CLOSED_MOUTH_POSE

        if (currentFrameData && nextFrameData) {
          drawAvatar(
            ctx,
            interpolateFrames(currentFrameData, nextFrameData, Math.min(progress, 1) * 0.5),
            canvasWidth,
            canvasHeight,
            idleOffsetRef.current,
            mouthPose,
          )
        } else {
          drawAvatar(ctx, null, canvasWidth, canvasHeight, idleOffsetRef.current, CLOSED_MOUTH_POSE)
        }
      } else {
        lastFrameTimeRef.current = timestamp
        drawAvatar(
          ctx,
          hasValidSignData ? framesToUse[frameIndexRef.current] || framesToUse[0] || null : null,
          canvasWidth,
          canvasHeight,
          idleOffsetRef.current,
          CLOSED_MOUTH_POSE,
        )
      }

      animationRef.current = requestAnimationFrame(animate)
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
    }
  }, [signData, isPlaying, showIdle, drawAvatar, interpolateFrames, onFrameChange, onPlaybackComplete])

  return (
    <motion.div
      className="relative w-full h-full min-h-[260px] md:min-h-[300px] flex items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      <canvas
        ref={canvasRef}
        className="rounded-xl shadow-sm"
        style={{
          width: 500,
          height: 500,
          maxWidth: "100%",
          maxHeight: "100%",
          background: "#ffffff",
        }}
        aria-label={signData ? `Avatar performing sign for: ${signData.word}` : "Avatar idle"}
        role="img"
      />
    </motion.div>
  )
}
