import type { SignData, Frame } from "./types"

// Helper to generate smooth wave motion for demonstration
function generateWaveMotion(
  baseX: number,
  baseY: number,
  frameCount: number,
  amplitude: number = 0.05,
  frequency: number = 2
): { x: number; y: number }[] {
  return Array.from({ length: frameCount }, (_, i) => {
    const t = (i / frameCount) * Math.PI * frequency
    return {
      x: baseX + Math.sin(t) * amplitude,
      y: baseY + Math.cos(t) * amplitude * 0.5,
    }
  })
}

// Generate hand landmarks with movement
function generateHandFrames(
  frameCount: number,
  isLeft: boolean,
  motionType: "wave" | "fist" | "open" | "point" | "thumbsUp" | "circle"
): (import("./types").Landmark[] | null)[] {
  const baseHand = generateBaseHand(isLeft)
  
  return Array.from({ length: frameCount }, (_, frameIdx) => {
    const t = frameIdx / frameCount
    const landmarks = baseHand.map((point, idx) => {
      let x = point.x
      let y = point.y
      
      switch (motionType) {
        case "wave":
          // Wave motion - fingers spread and move
          if (idx >= 5) { // Fingers
            const fingerGroup = Math.floor((idx - 5) / 4)
            const wave = Math.sin(t * Math.PI * 4 + fingerGroup * 0.5) * 0.03
            y += wave
            x += wave * 0.5
          }
          break
          
        case "fist":
          // Curl fingers
          if (idx >= 5) {
            const curl = Math.sin(t * Math.PI) * 0.08
            y += curl
          }
          break
          
        case "open":
          // Spread fingers
          if (idx >= 5) {
            const fingerGroup = Math.floor((idx - 5) / 4)
            const spread = Math.sin(t * Math.PI) * (fingerGroup - 2) * 0.02
            x += spread
          }
          break
          
        case "point":
          // Index finger extended, others curled
          if (idx >= 9 && idx <= 12) {
            // Index finger - keep extended
            y -= Math.sin(t * Math.PI * 2) * 0.02
          } else if (idx >= 5 && idx !== 8) {
            // Other fingers curl
            y += 0.05
          }
          break
          
        case "thumbsUp":
          // Thumb up, fingers curled
          if (idx >= 1 && idx <= 4) {
            // Thumb
            y -= Math.sin(t * Math.PI) * 0.05
            x -= 0.02
          } else if (idx >= 5) {
            y += 0.06
          }
          break
          
        case "circle":
          // Circular motion
          const angle = t * Math.PI * 2
          x += Math.cos(angle) * 0.03
          y += Math.sin(angle) * 0.03
          break
      }
      
      return { x, y }
    })
    
    return landmarks
  })
}

// Base hand landmark positions (normalized 0-1)
function generateBaseHand(isLeft: boolean): { x: number; y: number }[] {
  const mirror = isLeft ? -1 : 1
  const baseX = 0.5
  const baseY = 0.5
  
  return [
    // Wrist
    { x: baseX, y: baseY + 0.15 },
    // Thumb
    { x: baseX + mirror * 0.08, y: baseY + 0.1 },
    { x: baseX + mirror * 0.12, y: baseY + 0.05 },
    { x: baseX + mirror * 0.14, y: baseY },
    { x: baseX + mirror * 0.15, y: baseY - 0.04 },
    // Index
    { x: baseX + mirror * 0.05, y: baseY + 0.05 },
    { x: baseX + mirror * 0.06, y: baseY - 0.05 },
    { x: baseX + mirror * 0.065, y: baseY - 0.12 },
    { x: baseX + mirror * 0.07, y: baseY - 0.17 },
    // Middle
    { x: baseX + mirror * 0.02, y: baseY + 0.04 },
    { x: baseX + mirror * 0.02, y: baseY - 0.07 },
    { x: baseX + mirror * 0.02, y: baseY - 0.15 },
    { x: baseX + mirror * 0.02, y: baseY - 0.2 },
    // Ring
    { x: baseX - mirror * 0.02, y: baseY + 0.05 },
    { x: baseX - mirror * 0.025, y: baseY - 0.05 },
    { x: baseX - mirror * 0.03, y: baseY - 0.12 },
    { x: baseX - mirror * 0.03, y: baseY - 0.17 },
    // Pinky
    { x: baseX - mirror * 0.05, y: baseY + 0.06 },
    { x: baseX - mirror * 0.06, y: baseY - 0.02 },
    { x: baseX - mirror * 0.07, y: baseY - 0.08 },
    { x: baseX - mirror * 0.075, y: baseY - 0.12 },
  ]
}

// Generate pose landmarks for upper body
function generatePoseFrames(
  frameCount: number,
  leftArmMotion: "neutral" | "raise" | "wave" | "chest" | "circle",
  rightArmMotion: "neutral" | "raise" | "wave" | "chest" | "circle"
): import("./types").Landmark[][] {
  return Array.from({ length: frameCount }, (_, frameIdx) => {
    const t = frameIdx / frameCount
    
    // Base pose (17 landmarks for upper body)
    const pose: { x: number; y: number }[] = [
      // 0-10: Face/head landmarks (we'll skip details)
      ...Array(11).fill({ x: 0.5, y: 0.25 }),
      // 11: Left shoulder
      { x: 0.35, y: 0.4 },
      // 12: Right shoulder
      { x: 0.65, y: 0.4 },
      // 13: Left elbow
      { x: 0.25, y: 0.55 },
      // 14: Right elbow
      { x: 0.75, y: 0.55 },
      // 15: Left wrist
      { x: 0.2, y: 0.7 },
      // 16: Right wrist
      { x: 0.8, y: 0.7 },
    ]
    
    // Apply arm motions
    const applyArmMotion = (
      elbowIdx: number, 
      wristIdx: number, 
      motion: string, 
      isLeft: boolean
    ) => {
      const dir = isLeft ? -1 : 1
      
      switch (motion) {
        case "raise":
          pose[elbowIdx] = {
            x: pose[elbowIdx].x + dir * Math.sin(t * Math.PI) * 0.1,
            y: pose[elbowIdx].y - Math.sin(t * Math.PI) * 0.15
          }
          pose[wristIdx] = {
            x: pose[wristIdx].x + dir * Math.sin(t * Math.PI) * 0.15,
            y: pose[wristIdx].y - Math.sin(t * Math.PI) * 0.25
          }
          break
          
        case "wave":
          pose[elbowIdx] = {
            x: pose[elbowIdx].x,
            y: pose[elbowIdx].y - 0.1
          }
          pose[wristIdx] = {
            x: pose[wristIdx].x + Math.sin(t * Math.PI * 4) * 0.08,
            y: pose[wristIdx].y - 0.2 + Math.cos(t * Math.PI * 4) * 0.03
          }
          break
          
        case "chest":
          pose[elbowIdx] = {
            x: 0.5 + dir * 0.1,
            y: 0.5
          }
          pose[wristIdx] = {
            x: 0.5 + dir * 0.05,
            y: 0.45 + Math.sin(t * Math.PI * 2) * 0.02
          }
          break
      }
    }
    
    applyArmMotion(13, 15, leftArmMotion, true)
    applyArmMotion(14, 16, rightArmMotion, false)
    
    return pose
  })
}

// Create sign data for common words
export function createSignData(word: string, fps: number = 30): SignData | null {
  const signConfigs: Record<string, { 
    frameCount: number
    leftHand: "wave" | "fist" | "open" | "point" | "thumbsUp" | "circle"
    rightHand: "wave" | "fist" | "open" | "point" | "thumbsUp" | "circle"
    leftArm: "neutral" | "raise" | "wave" | "chest" | "circle"
    rightArm: "neutral" | "raise" | "wave" | "chest" | "circle"
  }> = {
    hello: { frameCount: 45, leftHand: "open", rightHand: "wave", leftArm: "neutral", rightArm: "wave" },
    "thank you": { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "chest", rightArm: "chest" },
    thanks: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "chest", rightArm: "chest" },
    yes: { frameCount: 30, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    no: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "wave" },
    please: { frameCount: 40, leftHand: "open", rightHand: "circle", leftArm: "neutral", rightArm: "chest" },
    sorry: { frameCount: 45, leftHand: "fist", rightHand: "fist", leftArm: "chest", rightArm: "chest" },
    help: { frameCount: 40, leftHand: "open", rightHand: "thumbsUp", leftArm: "raise", rightArm: "raise" },
    friend: { frameCount: 50, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    love: { frameCount: 45, leftHand: "fist", rightHand: "fist", leftArm: "chest", rightArm: "chest" },
    eat: { frameCount: 35, leftHand: "open", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    drink: { frameCount: 40, leftHand: "open", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    happy: { frameCount: 45, leftHand: "open", rightHand: "open", leftArm: "raise", rightArm: "raise" },
    sad: { frameCount: 50, leftHand: "open", rightHand: "open", leftArm: "chest", rightArm: "chest" },
    good: { frameCount: 35, leftHand: "open", rightHand: "thumbsUp", leftArm: "neutral", rightArm: "raise" },
    bad: { frameCount: 35, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "chest" },
    water: { frameCount: 40, leftHand: "open", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    food: { frameCount: 35, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    home: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "chest" },
    family: { frameCount: 50, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "circle" },
    mother: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "chest" },
    father: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "raise" },
    baby: { frameCount: 45, leftHand: "open", rightHand: "open", leftArm: "chest", rightArm: "chest" },
    work: { frameCount: 40, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "neutral" },
    school: { frameCount: 45, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "neutral" },
    learn: { frameCount: 40, leftHand: "open", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    understand: { frameCount: 45, leftHand: "open", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    know: { frameCount: 35, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "chest" },
    want: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "raise", rightArm: "raise" },
    need: { frameCount: 35, leftHand: "fist", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    like: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "chest", rightArm: "chest" },
    name: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    what: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "wave" },
    where: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "wave" },
    when: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "circle" },
    why: { frameCount: 40, leftHand: "open", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    how: { frameCount: 40, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    who: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "circle" },
    more: { frameCount: 40, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "neutral" },
    again: { frameCount: 45, leftHand: "open", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    stop: { frameCount: 30, leftHand: "open", rightHand: "open", leftArm: "raise", rightArm: "raise" },
    go: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    come: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "wave" },
    sit: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    stand: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "raise" },
    walk: { frameCount: 45, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "neutral" },
    run: { frameCount: 35, leftHand: "fist", rightHand: "fist", leftArm: "wave", rightArm: "wave" },
    sleep: { frameCount: 50, leftHand: "open", rightHand: "open", leftArm: "chest", rightArm: "chest" },
    wake: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "raise", rightArm: "raise" },
    morning: { frameCount: 45, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "raise" },
    night: { frameCount: 45, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "chest" },
    today: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "neutral" },
    tomorrow: { frameCount: 45, leftHand: "thumbsUp", rightHand: "thumbsUp", leftArm: "neutral", rightArm: "raise" },
    yesterday: { frameCount: 45, leftHand: "thumbsUp", rightHand: "thumbsUp", leftArm: "neutral", rightArm: "chest" },
    week: { frameCount: 40, leftHand: "point", rightHand: "open", leftArm: "neutral", rightArm: "neutral" },
    month: { frameCount: 40, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    year: { frameCount: 45, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "circle" },
    time: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    day: { frameCount: 35, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "raise" },
    hot: { frameCount: 35, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "wave" },
    cold: { frameCount: 40, leftHand: "fist", rightHand: "fist", leftArm: "chest", rightArm: "chest" },
    big: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "raise", rightArm: "raise" },
    small: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    new: { frameCount: 35, leftHand: "open", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    old: { frameCount: 40, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "chest" },
    beautiful: { frameCount: 50, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "circle" },
    easy: { frameCount: 35, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "wave" },
    hard: { frameCount: 40, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    fast: { frameCount: 30, leftHand: "fist", rightHand: "fist", leftArm: "wave", rightArm: "wave" },
    slow: { frameCount: 50, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "neutral" },
    right: { frameCount: 35, leftHand: "open", rightHand: "thumbsUp", leftArm: "neutral", rightArm: "raise" },
    wrong: { frameCount: 40, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "wave" },
    true: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    false: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "wave" },
    same: { frameCount: 40, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    different: { frameCount: 45, leftHand: "point", rightHand: "point", leftArm: "wave", rightArm: "wave" },
    all: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "raise", rightArm: "raise" },
    many: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "wave" },
    few: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    one: { frameCount: 30, leftHand: "fist", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    two: { frameCount: 30, leftHand: "fist", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    three: { frameCount: 30, leftHand: "fist", rightHand: "open", leftArm: "neutral", rightArm: "raise" },
    four: { frameCount: 30, leftHand: "fist", rightHand: "open", leftArm: "neutral", rightArm: "raise" },
    five: { frameCount: 30, leftHand: "fist", rightHand: "open", leftArm: "neutral", rightArm: "raise" },
    book: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "neutral" },
    read: { frameCount: 45, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "wave" },
    write: { frameCount: 45, leftHand: "open", rightHand: "point", leftArm: "neutral", rightArm: "wave" },
    sign: { frameCount: 40, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "wave" },
    language: { frameCount: 45, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "wave" },
    deaf: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "chest" },
    hearing: { frameCount: 40, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "chest" },
    speak: { frameCount: 40, leftHand: "open", rightHand: "point", leftArm: "neutral", rightArm: "chest" },
    say: { frameCount: 35, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "chest" },
    ask: { frameCount: 40, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    answer: { frameCount: 40, leftHand: "point", rightHand: "open", leftArm: "neutral", rightArm: "chest" },
    think: { frameCount: 45, leftHand: "fist", rightHand: "point", leftArm: "neutral", rightArm: "chest" },
    feel: { frameCount: 40, leftHand: "open", rightHand: "open", leftArm: "chest", rightArm: "chest" },
    see: { frameCount: 35, leftHand: "open", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    look: { frameCount: 40, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "wave" },
    watch: { frameCount: 45, leftHand: "open", rightHand: "point", leftArm: "neutral", rightArm: "neutral" },
    wait: { frameCount: 50, leftHand: "open", rightHand: "open", leftArm: "neutral", rightArm: "neutral" },
    finish: { frameCount: 35, leftHand: "open", rightHand: "open", leftArm: "wave", rightArm: "wave" },
    start: { frameCount: 40, leftHand: "point", rightHand: "point", leftArm: "neutral", rightArm: "raise" },
    try: { frameCount: 40, leftHand: "fist", rightHand: "fist", leftArm: "neutral", rightArm: "raise" },
    practice: { frameCount: 45, leftHand: "fist", rightHand: "open", leftArm: "neutral", rightArm: "neutral" },
  }

  const config = signConfigs[word.toLowerCase()]
  if (!config) return null

  const { frameCount, leftHand, rightHand, leftArm, rightArm } = config
  
  const leftHandFrames = generateHandFrames(frameCount, true, leftHand)
  const rightHandFrames = generateHandFrames(frameCount, false, rightHand)
  const poseFrames = generatePoseFrames(frameCount, leftArm, rightArm)

  const frames: Frame[] = Array.from({ length: frameCount }, (_, i) => ({
    leftHand: leftHandFrames[i],
    rightHand: rightHandFrames[i],
    pose: poseFrames[i],
  }))

  return {
    word,
    fps,
    frames,
  }
}

// Get list of available words
export function getAvailableWords(): string[] {
  return []
}

// Get suggested words for display
export function getSuggestedWords(): string[] {
  return []
}
