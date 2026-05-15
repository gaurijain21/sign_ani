"use client"

import { useState, useCallback, useEffect, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { RefreshCw, AlertCircle, Loader2, Video, Database, ThumbsDown, ThumbsUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AvatarCanvas } from "./AvatarCanvas"
import type { SignData, SignStatus } from "@/lib/types"

export type FeedbackType = "thumbs_up" | "thumbs_down"
export type SignedItemFeedback = {
  signedItem: string
  itemIndex: number
  feedbackType: FeedbackType
  feedbackKey: string
}

interface AvatarDisplayProps {
  signData: SignData | null
  isLoading: boolean
  error: string | null
  searchedWord: string | null
  isPlaybackActive?: boolean
  signStatus?: SignStatus | null
  onPlaybackComplete?: () => void
  playbackKey?: string | number
  feedbackByItem?: Record<string, FeedbackType>
  onFeedback?: (feedback: SignedItemFeedback) => void
}

export function AvatarDisplay({ 
  signData, 
  isLoading, 
  error, 
  searchedWord,
  isPlaybackActive = true,
  signStatus,
  onPlaybackComplete,
  playbackKey,
  feedbackByItem = {},
  onFeedback,
}: AvatarDisplayProps) {
  const [isPlaying, setIsPlaying] = useState(true)
  const [playCount, setPlayCount] = useState(0)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [isComplete, setIsComplete] = useState(false)

  useEffect(() => {
    setCurrentFrame(0)
    setIsComplete(false)
  }, [playbackKey, signData])

  const handleReplay = useCallback(() => {
    setIsPlaying(false)
    setCurrentFrame(0)
    setIsComplete(false)
    setTimeout(() => {
      setIsPlaying(true)
      setPlayCount(prev => prev + 1)
    }, 50)
  }, [])

  const handlePlaybackComplete = useCallback(() => {
    setIsComplete(true)
    onPlaybackComplete?.()
  }, [onPlaybackComplete])

  const playableSignData = signData?.frames?.length ? signData : null
  const activeDisplay = useMemo(() => {
    if (!playableSignData) return null
    if (isComplete) return { primary: "", subtitle: "", itemIndex: -1, feedbackKey: "" }

    const timeline = playableSignData.wordTimeline || []
    if (!timeline.length) {
      return {
        primary: playableSignData.word,
        subtitle: "",
        itemIndex: 0,
        feedbackKey: `${playableSignData.word}:0:${playableSignData.word}`,
      }
    }

    // Fingerspelling playback preserves a per-letter timeline, so this header
    // can show the active letter while regular signs continue to show the word.
    const activeItemIndex = timeline.findIndex(
      (item) => currentFrame >= item.startFrame && currentFrame <= item.endFrame,
    )
    const activeWord = activeItemIndex >= 0 ? timeline[activeItemIndex] : timeline[0]
    const primary = activeWord?.displayWord || timeline[0]?.displayWord || playableSignData.word
    const fingerspelledWords = playableSignData.metadata?.fingerspelledWords
    const subtitle = Array.isArray(fingerspelledWords) && primary.length === 1
      ? `Fingerspelling: ${fingerspelledWords.join(", ")}`
      : ""

    return {
      primary,
      subtitle,
      itemIndex: activeItemIndex >= 0 ? activeItemIndex : 0,
      feedbackKey: `${playableSignData.word}:${activeItemIndex >= 0 ? activeItemIndex : 0}:${primary}`,
    }
  }, [currentFrame, isComplete, playableSignData])

  const activeFeedback = activeDisplay?.feedbackKey ? feedbackByItem[activeDisplay.feedbackKey] : undefined

  const handleFeedback = useCallback((feedbackType: FeedbackType) => {
    if (!activeDisplay?.primary || activeDisplay.itemIndex < 0) return
    onFeedback?.({
      signedItem: activeDisplay.primary,
      itemIndex: activeDisplay.itemIndex,
      feedbackType,
      feedbackKey: activeDisplay.feedbackKey,
    })
  }, [activeDisplay, onFeedback])

  // Get appropriate error message based on status
  const getErrorContent = () => {
    if (signStatus === "needs_processing") {
      return {
        icon: <Video className="w-8 h-8 text-yellow-500" />,
        iconBg: "bg-yellow-100 dark:bg-yellow-900/30",
        title: "Processing Required",
        message: "This sign exists in WLASL but needs preprocessing.",
        hint: "Run scripts/extract_landmarks.py to generate the animation data.",
      }
    }
    
    if (signStatus === "not_downloaded") {
      return {
        icon: <Database className="w-8 h-8 text-blue-500" />,
        iconBg: "bg-blue-100 dark:bg-blue-900/30",
        title: "Processing Required",
        message: "This sign exists in WLASL but needs preprocessing.",
        hint: "Run the WLASL downloader/preprocess flow, then rebuild the manifest.",
      }
    }
    
    if (signStatus === "not_in_wlasl") {
      return {
        icon: <AlertCircle className="w-8 h-8 text-destructive" />,
        iconBg: "bg-destructive/10",
        title: "Not in WLASL",
        message: "This word is not available in the current WLASL dataset.",
        hint: "Try a different word or check the WLASL glossary.",
      }
    }
    
    // Default error
    return {
      icon: <AlertCircle className="w-8 h-8 text-destructive" />,
      iconBg: "bg-destructive/10",
      title: "Sign Not Found",
      message: error || `The sign for "${searchedWord}" is not available.`,
      hint: 'Try a common word like "hello" or "thank you"',
    }
  }

  return (
    <div className="relative w-full h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div>
          <AnimatePresence mode="wait">
            {playableSignData ? (
              activeDisplay?.primary ? (
                <motion.div
                  key={activeDisplay.primary}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                >
                  <p className="text-sm font-medium text-muted-foreground">Translating:</p>
                  <h2 className="text-2xl font-bold text-foreground capitalize">
                    {activeDisplay.primary}
                  </h2>
                  {activeDisplay.subtitle ? (
                    <p className="text-xs text-muted-foreground">{activeDisplay.subtitle}</p>
                  ) : null}
                </motion.div>
              ) : null
            ) : searchedWord && !isLoading ? (
              <motion.h2
                key="not-found"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xl font-medium text-muted-foreground"
              >
                {error ? "Sign not available" : "Ready to sign"}
              </motion.h2>
            ) : (
              <motion.h2
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-xl font-medium text-muted-foreground"
              >
                {isLoading ? "Loading..." : "Enter a word to see the sign"}
              </motion.h2>
            )}
          </AnimatePresence>
        </div>
        
        {playableSignData && (
          <Button
            variant="outline"
            size="icon"
            onClick={handleReplay}
            className="rounded-full"
            aria-label="Replay sign animation"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Canvas area */}
      <div className="flex-1 relative bg-gradient-to-b from-secondary/30 to-secondary/10 rounded-b-2xl overflow-hidden min-h-[300px] md:min-h-[400px]">
        <AnimatePresence mode="wait">
          {isLoading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              <div className="text-center space-y-4">
                <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto" />
                <p className="text-muted-foreground">Loading sign data...</p>
              </div>
            </motion.div>
          ) : error && searchedWord && !playableSignData ? (
            <motion.div
              key="error"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              {(() => {
                const errorContent = getErrorContent()
                return (
                  <div className="text-center space-y-4 p-8 max-w-sm">
                    <div className={`w-16 h-16 rounded-full ${errorContent.iconBg} flex items-center justify-center mx-auto`}>
                      {errorContent.icon}
                    </div>
                    <div>
                      <h3 className="font-semibold text-foreground">{errorContent.title}</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        {errorContent.message}
                      </p>
                      <p className="text-xs text-muted-foreground mt-3 p-2 bg-muted/50 rounded-lg">
                        {errorContent.hint}
                      </p>
                    </div>
                  </div>
                )
              })()}
            </motion.div>
          ) : (
            <motion.div
              key={`avatar-${playbackKey ?? ""}-${playCount}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-start justify-center p-3 md:items-center md:p-4"
            >
              <AvatarCanvas
                signData={playableSignData}
                isPlaying={isPlaying && isPlaybackActive}
                onPlaybackComplete={handlePlaybackComplete}
                onFrameChange={setCurrentFrame}
                showIdle={true}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {playableSignData ? (
        <div className="flex items-center justify-center gap-2 border-t border-border bg-card/80 px-4 py-3">
          <Button
            variant={activeFeedback === "thumbs_up" ? "default" : "outline"}
            size="icon"
            onClick={() => handleFeedback("thumbs_up")}
            disabled={!activeDisplay?.primary}
            aria-label="Mark current signed item as correct"
            className="rounded-full"
          >
            <ThumbsUp className="w-4 h-4" />
          </Button>
          <Button
            variant={activeFeedback === "thumbs_down" ? "default" : "outline"}
            size="icon"
            onClick={() => handleFeedback("thumbs_down")}
            disabled={!activeDisplay?.primary}
            aria-label="Mark current signed item as incorrect"
            className="rounded-full"
          >
            <ThumbsDown className="w-4 h-4" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
