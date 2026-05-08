import type { Frame, Landmark } from "@/lib/types"

export type FaceTemplatePoint = { x: number; y: number }

export interface FaceTemplateStroke {
  points: FaceTemplatePoint[]
  closed?: boolean
  width?: number
}

export interface FaceTemplateDot {
  center: FaceTemplatePoint
  radius: number
}

export interface FaceTemplate {
  source: string
  strokes: FaceTemplateStroke[]
  dots: FaceTemplateDot[]
}

type FrameWithFace = Frame & {
  face?: Landmark[] | null
  face_landmarks?: Landmark[] | null
  faceLandmarks?: Landmark[] | null
}

const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]
const LEFT_EYE = [33, 160, 158, 133, 153, 144]
const RIGHT_EYE = [362, 385, 387, 263, 373, 380]
// const LEFT_BROW = [70, 63, 105, 66, 107]
export const FIXED_FACE_TEMPLATE: FaceTemplate = {
  source:
    "Reusable smiley circle face template. The mouth is intentionally not part of this template; AvatarCanvas draws the animated mouth separately.",
  strokes: [
    {
      points: [
        { x: 0, y: -1 },
        { x: 0.38, y: -0.92 },
        { x: 0.7, y: -0.7 },
        { x: 0.92, y: -0.38 },
        { x: 1, y: 0 },
        { x: 0.92, y: 0.38 },
        { x: 0.7, y: 0.7 },
        { x: 0.38, y: 0.92 },
        { x: 0, y: 1 },
        { x: -0.38, y: 0.92 },
        { x: -0.7, y: 0.7 },
        { x: -0.92, y: 0.38 },
        { x: -1, y: 0 },
        { x: -0.92, y: -0.38 },
        { x: -0.7, y: -0.7 },
        { x: -0.38, y: -0.92 },
      ],
      closed: true,
      width: 0.04,
    },
    {
      points: [
        { x: -0.54, y: -0.28 },
        { x: -0.42, y: -0.4 },
        { x: -0.28, y: -0.42 },
        { x: -0.14, y: -0.34 },
      ],
      width: 0.055,
    },
    {
      points: [
        { x: 0.14, y: -0.34 },
        { x: 0.28, y: -0.42 },
        { x: 0.42, y: -0.4 },
        { x: 0.54, y: -0.28 },
      ],
      width: 0.055,
    },
  ],
  dots: [],
}

function isValidLandmark(point: Landmark | null | undefined): point is Landmark {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

function pointsFromIndices(face: Landmark[], indices: number[]): FaceTemplatePoint[] {
  const usableFace = face.filter(isValidLandmark)
  if (!usableFace.length) return []

  const xs = usableFace.map((point) => point.x)
  const ys = usableFace.map((point) => point.y)
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.001) / 2

  return indices
    .map((index) => face[index])
    .filter(isValidLandmark)
    .map((point) => ({
      x: (point.x - centerX) / scale,
      y: (point.y - centerY) / scale,
    }))
}

export function createFaceTemplateFromReferenceFrame(frame: Frame | null): FaceTemplate {
  // If the loaded reference frame includes MediaPipe face landmarks, trace one
  // rough line-art template from that first frame. AvatarCanvas caches this
  // result, so later words reuse the same face instead of regenerating it.
  const frameWithFace = frame as FrameWithFace | null
  const face = frameWithFace?.faceLandmarks || frameWithFace?.face_landmarks || frameWithFace?.face || null
  if (face?.length) {
    return {
      source:
        "Extracted once from the first usable frame's face landmarks. Replace FIXED_FACE_TEMPLATE or provide a custom face landmark reference to update the app-wide face.",
      strokes: [
        { points: pointsFromIndices(face, FACE_OVAL), closed: true, width: 0.04 },
        { points: pointsFromIndices(face, LEFT_EYE), closed: true, width: 0.025 },
        { points: pointsFromIndices(face, RIGHT_EYE), closed: true, width: 0.025 },
        // { points: pointsFromIndices(face, LEFT_BROW), width: 0.035 },
        // { points: pointsFromIndices(face, RIGHT_BROW), width: 0.035 },
        // { points: pointsFromIndices(face, NOSE), width: 0.025 },
      ].filter((stroke) => stroke.points.length >= 2),
      dots: [],
    }
  }

  // Most currently served sign JSON only has pose/hands. In that case, keep one
  // stable fallback template for the whole app and swap this constant later with
  // points traced from your custom drawing or a generated reference frame.
  return FIXED_FACE_TEMPLATE
}
