"use client"

import { useRef, useEffect, useCallback, useState } from "react"
import { motion } from "framer-motion"
import type { SignData, Frame, Landmark } from "@/lib/types"

interface AvatarCanvasProps {
  signData: SignData | null
  isPlaying: boolean
  onPlaybackComplete?: () => void
  showIdle?: boolean
}

type CanvasPoint = { x: number; y: number }
type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

const FINGER_SEGMENTS = [
  { start: 1, joints: [2, 3, 4], color: "#e74c3c" },
  { start: 5, joints: [6, 7, 8], color: "#3498db" },
  { start: 9, joints: [10, 11, 12], color: "#2ecc71" },
  { start: 13, joints: [14, 15, 16], color: "#f39c12" },
  { start: 17, joints: [18, 19, 20], color: "#9b59b6" },
]

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

export function AvatarCanvas({
  signData,
  isPlaying,
  onPlaybackComplete,
  showIdle = true,
}: AvatarCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number | null>(null)
  const frameIndexRef = useRef(0)
  const lastFrameTimeRef = useRef(0)
  const idleOffsetRef = useRef(0)
  const [currentFrame, setCurrentFrame] = useState(0)
  const demoFrames = useRef(generateDemoFrames())

  const interpolateFrames = useCallback((frame1: Frame, frame2: Frame, t: number): Frame => {
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

    return {
      leftHand: interpolateLandmarks(frame1.leftHand, frame2.leftHand),
      rightHand: interpolateLandmarks(frame1.rightHand, frame2.rightHand),
      pose: interpolateLandmarks(frame1.pose, frame2.pose),
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

    ;[[0, 5], [0, 9], [0, 13], [0, 17], [5, 9], [9, 13], [13, 17]].forEach(([start, end]) => {
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
  ) => {
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, width, height)

    const points = collectLandmarks(frame)
    const bounds = computeBounds(points)
    if (!frame || !bounds) return

    const floatY = Math.sin(idleOffset * 0.02) * 2
    const sourceWidth = Math.max(bounds.maxX - bounds.minX, 0.12)
    const sourceHeight = Math.max(bounds.maxY - bounds.minY, 0.12)
    const scale = Math.min((width * 0.82) / sourceWidth, (height * 0.82) / sourceHeight)
    const sourceCenterX = (bounds.minX + bounds.maxX) / 2
    const sourceCenterY = (bounds.minY + bounds.maxY) / 2
    const canvasCenterX = width / 2
    const canvasCenterY = height * 0.49 + floatY

    const transform = (point: Landmark): CanvasPoint => ({
      x: canvasCenterX + (point.x - sourceCenterX) * scale,
      y: canvasCenterY + (point.y - sourceCenterY) * scale,
    })

    const pose = mapLandmarks(frame.pose, transform)
    const leftHand = mapLandmarks(frame.leftHand, transform)
    const rightHand = mapLandmarks(frame.rightHand, transform)

    const nose = pose[0]
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
      : { x: canvasCenterX, y: canvasCenterY + shoulderDistance * 0.2 }
    const headCenter = nose || { x: shoulderCenter.x, y: shoulderCenter.y - shoulderDistance * 0.85 }
    const headRadius = Math.max(28, Math.min(58, shoulderDistance * 0.38))
    const outlineColor = "#d64545"
    const faceColor = "#333333"

    ctx.save()
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    ctx.beginPath()
    ctx.arc(headCenter.x, headCenter.y, headRadius, 0, Math.PI * 2)
    ctx.strokeStyle = faceColor
    ctx.lineWidth = 3
    ctx.stroke()

    const eyeY = headCenter.y - headRadius * 0.12
    const eyeOffset = headRadius * 0.34
    drawDot(ctx, { x: headCenter.x - eyeOffset, y: eyeY }, 3.2, faceColor)
    drawDot(ctx, { x: headCenter.x + eyeOffset, y: eyeY }, 3.2, faceColor)

    ctx.beginPath()
    ctx.arc(headCenter.x, headCenter.y + headRadius * 0.22, headRadius * 0.22, 0.12 * Math.PI, 0.88 * Math.PI)
    ctx.strokeStyle = faceColor
    ctx.lineWidth = 2
    ctx.stroke()

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
  }, [drawHand])

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

    frameIndexRef.current = 0
    lastFrameTimeRef.current = 0

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
        }

        const currentIdx = frameIndexRef.current
        const nextIdx = (currentIdx + 1) % framesToUse.length
        const progress = (timestamp - lastFrameTimeRef.current) / frameDuration
        const currentFrameData = framesToUse[currentIdx]
        const nextFrameData = framesToUse[nextIdx]

        if (currentFrameData && nextFrameData) {
          drawAvatar(
            ctx,
            interpolateFrames(currentFrameData, nextFrameData, Math.min(progress, 1) * 0.5),
            canvasWidth,
            canvasHeight,
            idleOffsetRef.current,
          )
        } else {
          drawAvatar(ctx, null, canvasWidth, canvasHeight, idleOffsetRef.current)
        }
      } else {
        drawAvatar(ctx, null, canvasWidth, canvasHeight, idleOffsetRef.current)
      }

      animationRef.current = requestAnimationFrame(animate)
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
    }
  }, [signData, isPlaying, showIdle, drawAvatar, interpolateFrames, onPlaybackComplete])

  return (
    <motion.div
      className="relative w-full h-full min-h-[300px] flex items-center justify-center"
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
      {signData && isPlaying && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1">
          {signData.frames.slice(0, Math.min(signData.frames.length, 20)).map((_, idx) => (
            <div
              key={idx}
              className={`h-2 w-2 rounded-full transition-colors ${
                Math.floor(currentFrame / Math.ceil(signData.frames.length / 20)) === idx
                  ? "bg-primary"
                  : "bg-muted-foreground/30"
              }`}
            />
          ))}
        </div>
      )}
    </motion.div>
  )
}
