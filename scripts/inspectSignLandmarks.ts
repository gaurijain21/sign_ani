import { readFileSync } from "fs"
import * as path from "path"

type Landmark = { x: number; y: number; z?: number }
type Frame = {
  leftHand?: Landmark[] | null
  rightHand?: Landmark[] | null
  pose?: Landmark[] | null
  mouth?: Landmark[] | null
  mouthLandmarks?: Landmark[] | null
  mouth_landmarks?: Landmark[] | null
}
type SignData = {
  word?: string
  frames?: Frame[]
}

function normalizeSignName(input: string): string {
  return input.toLowerCase().trim().replace(/\s+/g, "_")
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

function distance(a: Landmark | null, b: Landmark | null): number | null {
  if (!a || !b) return null
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0))
}

function formatPoint(point: Landmark | null | undefined): string {
  if (!point) return "missing"
  return `x=${point.x.toFixed(4)}, y=${point.y.toFixed(4)}, z=${(point.z || 0).toFixed(4)}`
}

function getMouthLandmarks(frame: Frame): Landmark[] | null {
  return frame.mouthLandmarks || frame.mouth_landmarks || frame.mouth || null
}

function getChestCenter(frame: Frame): Landmark | null {
  const leftShoulder = frame.pose?.[11]
  const rightShoulder = frame.pose?.[12]
  if (!leftShoulder || !rightShoulder) return null

  return {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
    z: ((leftShoulder.z || 0) + (rightShoulder.z || 0)) / 2,
  }
}

function classifyHandStart(handCenter: Landmark | null, mouthCenter: Landmark | null, chestCenter: Landmark | null): string {
  const mouthDistance = distance(handCenter, mouthCenter)
  const chestDistance = distance(handCenter, chestCenter)
  if (mouthDistance === null || chestDistance === null) return "unknown due to missing face/body landmarks"
  return mouthDistance <= chestDistance ? "closer to face/mouth/chin" : "closer to shoulder/chest"
}

const signName = process.argv.slice(2).join(" ") || "thank you"
const jsonPath = path.join(process.cwd(), "public", "data", "signs", `${normalizeSignName(signName)}.json`)
const data = JSON.parse(readFileSync(jsonPath, "utf8")) as SignData
const frames = data.frames || []

console.log(`sign name: ${data.word || signName}`)
console.log(`JSON file path: ${jsonPath}`)
console.log(`frame count: ${frames.length}`)

frames.slice(0, 5).forEach((frame, index) => {
  const hand = frame.rightHand?.length ? frame.rightHand : frame.leftHand
  const wrist = hand?.[0] || null
  const indexFinger = hand?.[8] || null
  const handCenter = averageLandmark(hand)
  const mouthCenter = averageLandmark(getMouthLandmarks(frame))
  const chestCenter = getChestCenter(frame)

  console.log(`\nframe ${index}`)
  console.log(`wrist: ${formatPoint(wrist)}`)
  console.log(`index finger landmark 8: ${formatPoint(indexFinger)}`)
  console.log(`hand center: ${formatPoint(handCenter)}`)
  console.log(`mouth/chin estimate: ${formatPoint(mouthCenter)}`)
  console.log(`shoulder/chest estimate: ${formatPoint(chestCenter)}`)
  console.log(`start classification: ${classifyHandStart(handCenter, mouthCenter, chestCenter)}`)
})
