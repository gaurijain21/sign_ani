"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { addDoc, collection, serverTimestamp } from "firebase/firestore"
import Link from "next/link"
import {
  Github,
  Hand,
  Info,
  Loader2,
  Pause,
  Play,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react"
import { AvatarDisplay, type ActiveSignedItem, type FeedbackType, type SignedItemFeedback } from "@/components/AvatarDisplay"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  fetchFingerspellingAnimation,
  fetchSignAnimation,
  loadSignDictionary,
  resolveSentenceWithAI,
} from "@/lib/signDictionary"
import { trackSignWizEvent } from "@/lib/analytics"
import { getFirebaseDb } from "@/lib/firebase"
import { buildSentenceAnimation, type SentenceAnimationResult } from "@/lib/sentenceAnimation"
import type { MissingWordReplacement, PlaybackQueueItem, SignData, SignDictionaryEntry } from "@/lib/types"

const DEFAULT_SENTENCE = "type a word here"
type TranslationMode = "live" | "learning"
type PlaybackFeedbackType = "regular_sign" | "fingerspell_letter" | "phrase_sign" | "synonym" | "ai_semantic_match"
type FeedbackResolvedFrom = "exact" | "protected_phrase" | "synonymMap" | "word_form" | "ai" | "fingerspell"
type PlaybackFeedbackItem = {
  inputText: string
  originalWord: string
  playbackItem: string
  playbackType: PlaybackFeedbackType
  resolvedFrom: FeedbackResolvedFrom
  itemIndex: number
  signSource: string | null
}
type FeedbackDocument = {
  inputText: string
  originalWord: string
  playbackItem: string
  playbackType: PlaybackFeedbackType
  resolvedFrom: FeedbackResolvedFrom
  feedback: "up" | "down"
  itemIndex: number
  signSource: string | null
  createdAt: ReturnType<typeof serverTimestamp>
}
type DictionaryStats = {
  synonymFilePathLoaded?: string
  originalWordCount: number
  synonymEntryCount: number
  uniqueResolvableWordCount: number
  sampleSynonymMappings?: Array<{ word: string; mappedWord: string }>
  warning?: string | null
}

const PROTECTED_PHRASE_WORDS = new Set(["thank you", "no way", "don't know", "i love you", "good bye"])

function getPlaybackType(item: PlaybackQueueItem): PlaybackFeedbackType {
  if (item.type === "fingerspell") return "fingerspell_letter"
  if (item.resolutionType === "ai") return "ai_semantic_match"
  if (item.resolutionType === "synonym") return "synonym"
  if (item.type === "phrase") return "phrase_sign"
  return "regular_sign"
}

function getResolvedFrom(item: PlaybackQueueItem): FeedbackResolvedFrom {
  if (item.resolutionType === "fingerspell") return "fingerspell"
  if (item.resolutionType === "ai") return "ai"
  if (item.resolutionType === "synonym") return "synonymMap"
  if (PROTECTED_PHRASE_WORDS.has(item.gloss)) return "protected_phrase"
  return "exact"
}

function buildPlaybackFeedbackItems(
  inputText: string,
  playableQueue: PlaybackQueueItem[],
): PlaybackFeedbackItem[] {
  const items: PlaybackFeedbackItem[] = []

  playableQueue.forEach((item) => {
    if (item.type === "fingerspell") {
      ;(item.fingerspellLetters || []).forEach((letter) => {
        items.push({
          inputText,
          originalWord: item.text,
          playbackItem: letter,
          playbackType: "fingerspell_letter",
          resolvedFrom: "fingerspell",
          itemIndex: items.length,
          signSource: "fingerspelling",
        })
      })
      return
    }

    items.push({
      inputText,
      originalWord: item.text,
      playbackItem: item.gloss,
      playbackType: getPlaybackType(item),
      resolvedFrom: getResolvedFrom(item),
      itemIndex: items.length,
      signSource: item.entry?.source || null,
    })
  })

  return items
}

function getStoredRecords(key: string) {
  if (typeof window === "undefined") return []
  const existing = window.localStorage.getItem(key)
  try {
    return existing ? JSON.parse(existing) as unknown[] : []
  } catch {
    return []
  }
}

function saveFeedbackToLocalStorage(feedbackDocument: FeedbackDocument) {
  if (typeof window === "undefined") return

  const fallbackKey = "signwiz_feedback_fallback"
  const { createdAt: _serverCreatedAt, ...serializableFeedback } = feedbackDocument
  const feedbackRecords = getStoredRecords(fallbackKey)
  feedbackRecords.push({
    ...serializableFeedback,
    createdAt: new Date().toISOString(),
  })
  window.localStorage.setItem(fallbackKey, JSON.stringify(feedbackRecords))
}

export default function Home() {
  const [sentence, setSentence] = useState(DEFAULT_SENTENCE)
  const [mode, setMode] = useState<TranslationMode>("live")
  const [currentLearningWords, setCurrentLearningWords] = useState<string[]>([])
  const [learningHistory, setLearningHistory] = useState<string[][]>([])
  const [learningHistoryIndex, setLearningHistoryIndex] = useState(-1)
  const [dictionary, setDictionary] = useState<SignDictionaryEntry[]>([])
  const [dictionaryLoading, setDictionaryLoading] = useState(true)
  const [dictionaryError, setDictionaryError] = useState<string | null>(null)
  const [queue, setQueue] = useState<PlaybackQueueItem[]>([])
  const [currentSignData, setCurrentSignData] = useState<SignData | null>(null)
  const [sentenceAnimation, setSentenceAnimation] = useState<SentenceAnimationResult | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isSignLoading, setIsSignLoading] = useState(false)
  const [isResolvingWords, setIsResolvingWords] = useState(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [playbackVersion, setPlaybackVersion] = useState(0)
  const [showSkippedWords] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [aiReplacements, setAiReplacements] = useState<MissingWordReplacement[]>([])
  const [aiUnresolved, setAiUnresolved] = useState<string[]>([])
  const [aiUnavailable, setAiUnavailable] = useState(false)
  const [feedbackByItem, setFeedbackByItem] = useState<Record<string, FeedbackType>>({})
  const [activeSignedItem, setActiveSignedItem] = useState<ActiveSignedItem | null>(null)
  const [adRefreshKey, setAdRefreshKey] = useState(0)
  const [dictionaryStats, setDictionaryStats] = useState<DictionaryStats | null>(null)

  const trackAnalyticsEvent = useCallback((
    eventName: string,
    metadata: Record<string, string | number | boolean | null | undefined> = {},
    eventType = "interaction",
  ) => {
    void trackSignWizEvent(eventName, {
      event_type: eventType,
      page_path: "/",
      page_title: "SignWiz",
      ...metadata,
    })
  }, [])

  useEffect(() => {
    void trackAnalyticsEvent("page_view_home", {}, "page_view")
    void trackAnalyticsEvent("ad_view_live_translation", { ad_slot: "home_animation" }, "ad_view")
  }, [trackAnalyticsEvent])

  useEffect(() => {
    fetch("/api/dictionary-stats")
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load dictionary stats.")
        return response.json() as Promise<DictionaryStats>
      })
      .then((stats) => {
        setDictionaryStats(stats)
        console.log("[dictionary-stats]", {
          synonymFilePathLoaded: stats.synonymFilePathLoaded,
          originalWordCount: stats.originalWordCount,
          synonymEntryCount: stats.synonymEntryCount,
          uniqueResolvableWordCount: stats.uniqueResolvableWordCount,
          sampleSynonymMappings: stats.sampleSynonymMappings,
          warning: stats.warning,
        })
      })
      .catch((error) => {
        console.warn("[dictionary-stats] unavailable", error)
      })
  }, [])

  useEffect(() => {
    loadSignDictionary()
      .then(({ entries }) => {
        setDictionary(entries)
      })
      .catch((error) => {
        setDictionaryError(error instanceof Error ? error.message : "Unable to load sign dictionary.")
      })
      .finally(() => setDictionaryLoading(false))
  }, [])

  const playableQueue = useMemo(
    () => queue.filter((item) => item.status === "available" && (item.entry || item.type === "fingerspell")),
    [queue],
  )

  const originalDictionaryWords = useMemo(
    () =>
      dictionary
        .filter((entry) =>
          entry.available &&
          entry.source === "WLASL" &&
          entry.gloss.trim() &&
          !entry.jsonPath.includes("/fingerspelling/"),
        )
        .map((entry) => entry.gloss),
    [dictionary],
  )

  const pickRandomLearningWords = useCallback(() => {
    const candidates = [...new Set(originalDictionaryWords)]
    const selected: string[] = []

    while (selected.length < 3 && candidates.length) {
      const randomIndex = Math.floor(Math.random() * candidates.length)
      const [word] = candidates.splice(randomIndex, 1)
      if (word) selected.push(word)
    }

    return selected
  }, [originalDictionaryWords])

  const buildQueueForSentence = useCallback(async (input: string) => {
    setIsResolvingWords(true)
    setAiReplacements([])
    setAiUnresolved([])
    setAiUnavailable(false)

    const resolved = await resolveSentenceWithAI(input, dictionary, showSkippedWords)
    setQueue(resolved.queue)
    setAiReplacements(resolved.replacements)
    setAiUnresolved(resolved.unresolved)
    setAiUnavailable(resolved.aiUnavailable)
    setCurrentSignData(null)
    setSentenceAnimation(null)
    setPlaybackError(null)
    setPlaybackVersion((version) => version + 1)
    setIsPlaying(resolved.queue.some((item) => item.status === "available"))
    setIsResolvingWords(false)
  }, [dictionary, showSkippedWords])

  const buildQueue = useCallback(async () => {
    await buildQueueForSentence(sentence)
  }, [buildQueueForSentence, sentence])

  const playLearningWords = useCallback(async (words: string[]) => {
    const learningSentence = words.join(" ")
    setCurrentLearningWords(words)
    setSentence(learningSentence)
    await buildQueueForSentence(learningSentence)
  }, [buildQueueForSentence])

  const startLearningMode = useCallback(async () => {
    void trackAnalyticsEvent("button_click_start_learning")
    void trackAnalyticsEvent("page_view_start_learning", {}, "page_view")
    void trackAnalyticsEvent("ad_view_start_learning", { ad_slot: "home_animation" }, "ad_view")
    const words = pickRandomLearningWords()
    if (!words.length) return

    setMode("learning")
    setLearningHistory([words])
    setLearningHistoryIndex(0)
    await playLearningWords(words)
  }, [pickRandomLearningWords, playLearningWords, trackAnalyticsEvent])

  const showNextLearningSet = useCallback(async () => {
    void trackAnalyticsEvent("button_click_next")
    const words = pickRandomLearningWords()
    if (!words.length) return

    const nextHistory = learningHistory.slice(0, learningHistoryIndex + 1)
    nextHistory.push(words)
    setLearningHistory(nextHistory)
    setLearningHistoryIndex(nextHistory.length - 1)
    await playLearningWords(words)
  }, [learningHistory, learningHistoryIndex, pickRandomLearningWords, playLearningWords, trackAnalyticsEvent])

  const showPreviousLearningSet = useCallback(async () => {
    void trackAnalyticsEvent("button_click_back")
    const previousIndex = learningHistoryIndex - 1
    const words = learningHistory[previousIndex]
    if (!words) return

    setLearningHistoryIndex(previousIndex)
    await playLearningWords(words)
  }, [learningHistory, learningHistoryIndex, playLearningWords, trackAnalyticsEvent])

  useEffect(() => {
    if (dictionary.length && queue.length === 0 && sentence.trim()) {
      void buildQueue()
    }
  }, [buildQueue, dictionary.length, queue.length, sentence])

  useEffect(() => {
    if (!isPlaying) return
    if (currentSignData?.frames.length && sentenceAnimation) return
    if (playableQueue.length === 0) {
      setCurrentSignData(null)
      setSentenceAnimation(null)
      return
    }

    let cancelled = false
    setIsSignLoading(true)
    setPlaybackError(null)

    Promise.allSettled(
      playableQueue.map((item) =>
        item.type === "fingerspell"
          ? fetchFingerspellingAnimation(item.text, item.fingerspellLetters || [])
          : fetchSignAnimation(item.entry!),
      ),
    )
      .then((results) => {
        if (cancelled) return

        const animationMap = new Map<string, SignData>()
        const failedWords: string[] = []

        results.forEach((result, index) => {
          const word = playableQueue[index].gloss
          if (result.status === "fulfilled") {
            animationMap.set(word, result.value)
          } else {
            failedWords.push(word)
          }
        })

        const words = playableQueue.map((item) => item.gloss)
        const built = buildSentenceAnimation(words, animationMap, { debug: true })
        const missingWords = [...built.missingWords, ...failedWords.filter((word) => !built.missingWords.includes(word))]
        const firstLoadedAnimation = results.find(
          (result): result is PromiseFulfilledResult<SignData> => result.status === "fulfilled",
        )?.value
        const playbackFeedbackItems = buildPlaybackFeedbackItems(sentence.trim() || words.join(" "), playableQueue)

        setSentenceAnimation({ ...built, missingWords })
        if (!built.frames.length) {
          setCurrentSignData(null)
          setPlaybackError("Unable to build a playable sentence animation.")
          setIsPlaying(false)
          return
        }

        setCurrentSignData({
          word: sentence.trim() || words.join(" "),
          fps: firstLoadedAnimation?.fps || 30,
          frames: built.frames,
          source: "wlasl",
          wordTimeline: built.wordTimeline,
          metadata: {
            fingerspelledWords: playableQueue
              .filter((item) => item.type === "fingerspell")
              .map((item) => item.text),
            playbackFeedbackItems,
          },
        })
      })
      .catch((error) => {
        if (!cancelled) {
          setCurrentSignData(null)
          setSentenceAnimation(null)
          setPlaybackError(error instanceof Error ? error.message : "Unable to load sentence animation.")
          setIsPlaying(false)
        }
      })
      .finally(() => {
        if (!cancelled) setIsSignLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [currentSignData, isPlaying, playableQueue, sentence, sentenceAnimation])

  const handleSentenceComplete = useCallback(() => {
    const context = mode === "learning" ? "start_learning" : "live_translation"
    void trackAnalyticsEvent(`ad_refresh_${context}`, { ad_slot: "home_animation" }, "ad_refresh")
    void trackAnalyticsEvent(`ad_view_${context}`, { ad_slot: "home_animation" }, "ad_view")
    setAdRefreshKey((key) => key + 1)
    setPlaybackVersion((version) => version + 1)
    setIsPlaying(playableQueue.length > 0)
  }, [mode, playableQueue.length, trackAnalyticsEvent])

  const currentDisplayWord = currentSignData?.word || sentence
  const activeFeedback = activeSignedItem?.feedbackKey ? feedbackByItem[activeSignedItem.feedbackKey] : undefined

  const handlePlaybackToggle = useCallback(() => {
    void trackAnalyticsEvent(isPlaying ? "button_click_pause" : "button_click_play")
    setIsPlaying((value) => !value)
  }, [isPlaying, trackAnalyticsEvent])

  const handleLiveTranslationClick = useCallback(() => {
    void trackAnalyticsEvent("button_click_live_translation")
    void trackAnalyticsEvent("ad_view_live_translation", { ad_slot: "home_animation" }, "ad_view")
    setMode("live")
  }, [trackAnalyticsEvent])

  const handleTranslateClick = useCallback(() => {
    void trackAnalyticsEvent("button_click_translate")
    void buildQueue()
  }, [buildQueue, trackAnalyticsEvent])

  const handleSignedItemFeedback = useCallback(async (feedback: SignedItemFeedback) => {
    void trackAnalyticsEvent(feedback.feedbackType === "thumbs_up" ? "button_click_thumbs_up" : "button_click_thumbs_down", {
      signedItem: feedback.signedItem,
      itemIndex: feedback.itemIndex,
    })
    const originalFullSentence = currentSignData?.word || sentence
    const playbackFeedbackItems = currentSignData?.metadata?.playbackFeedbackItems
    const playbackItem = Array.isArray(playbackFeedbackItems)
      ? playbackFeedbackItems[feedback.itemIndex] as PlaybackFeedbackItem | undefined
      : undefined
    const feedbackKey = feedback.feedbackKey || `${originalFullSentence}:${feedback.itemIndex}:${feedback.signedItem}`
    const feedbackDocument: FeedbackDocument = {
      inputText: playbackItem?.inputText || originalFullSentence,
      originalWord: playbackItem?.originalWord || feedback.signedItem,
      playbackItem: playbackItem?.playbackItem || feedback.signedItem,
      playbackType: playbackItem?.playbackType || "regular_sign",
      resolvedFrom: playbackItem?.resolvedFrom || "exact",
      feedback: feedback.feedbackType === "thumbs_up" ? "up" : "down",
      itemIndex: feedback.itemIndex,
      signSource: playbackItem?.signSource || null,
      createdAt: serverTimestamp(),
    }

    setFeedbackByItem((current) => ({
      ...current,
      [feedbackKey]: feedback.feedbackType,
    }))

    try {
      console.log("[feedback] preparing feedback document", feedbackDocument)
      const db = getFirebaseDb()
      if (!db) {
        console.warn("[feedback] Firestore unavailable, saved locally")
        saveFeedbackToLocalStorage(feedbackDocument)
        return
      }

      console.log("[feedback] attempting Firestore write")
      const docRef = await addDoc(collection(db, "feedback"), feedbackDocument)
      console.log("[feedback] Firestore write successful")
      console.log(`[feedback] created doc id: ${docRef.id}`)
    } catch (error) {
      console.error("[feedback] Firestore write failed:", error)
      console.warn("[feedback] Firestore unavailable, saved locally")
      saveFeedbackToLocalStorage(feedbackDocument)
    }
  }, [currentSignData?.metadata?.playbackFeedbackItems, currentSignData?.word, sentence, trackAnalyticsEvent])

  const handleFeedbackButtonClick = useCallback((feedbackType: FeedbackType) => {
    if (!activeSignedItem) return
    void handleSignedItemFeedback({
      signedItem: activeSignedItem.signedItem,
      itemIndex: activeSignedItem.itemIndex,
      feedbackKey: activeSignedItem.feedbackKey,
      feedbackType,
    })
  }, [activeSignedItem, handleSignedItemFeedback])

  const handleAdClick = useCallback(() => {
    const context = mode === "learning" ? "start_learning" : "live_translation"
    void trackAnalyticsEvent(`ad_click_${context}`, { ad_slot: "home_animation", ad_refresh_key: adRefreshKey }, "ad_click")
  }, [adRefreshKey, mode, trackAnalyticsEvent])

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 hidden border-b border-border bg-card/50 backdrop-blur-sm md:block">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <motion.div
              className="flex items-center gap-3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
                <Hand className="w-5 h-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">SignWiz</h1>
              </div>
            </motion.div>

            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => setShowInfo(!showInfo)}>
                <Info className="w-5 h-5" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {showInfo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="hidden border-b border-primary/20 bg-primary/10 md:block"
          >
            <div className="container mx-auto px-4 py-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Educational research demo</p>
              <p className="mt-1">
                This visualizes sentence input using phrase-first matching and word-level fallback. It is not a complete
                ASL grammar translator; ASL grammar differs from English grammar.
              </p>
              <a
                href="https://github.com/dxli94/WLASL"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
              >
                <Github className="w-4 h-4" />
                WLASL dataset
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="container mx-auto px-4 py-4 md:py-8">
        <div className="grid gap-4 md:gap-6 xl:grid-cols-[minmax(0,1fr)_560px] xl:gap-8">
          <div className="contents xl:block xl:space-y-6">
            <section className="order-2 space-y-4 md:order-1">
              <div>
                <h2 className="hidden text-3xl font-bold text-foreground text-balance md:block lg:text-4xl">
                  Learn and understand sign language effortlessly.
                </h2>
                <p className="mt-2 hidden text-muted-foreground md:block">
                  A simple and accessible platform helping kids, schools, and communities learn sign language through guided tutorials and live animated gestures.
                </p>
                <div className="flex flex-wrap gap-3 md:mt-6 lg:mt-8">
                  <Button variant={mode === "live" ? "default" : "outline"} onClick={handleLiveTranslationClick}>
                    Live Translation
                  </Button>
                  <Button
                    variant={mode === "learning" ? "default" : "outline"}
                    onClick={() => void startLearningMode()}
                    disabled={dictionaryLoading || isResolvingWords || originalDictionaryWords.length === 0}
                  >
                    {dictionaryLoading || isResolvingWords ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    Start Learning
                  </Button>
                </div>
              </div>

              <div className="space-y-3 md:mt-6 lg:mt-8">
                <div className="relative">
                  <Textarea
                    value={sentence}
                    onChange={(event) => setSentence(event.target.value)}
                    maxLength={150}
                    placeholder="Type a sentence here"
                    className="min-h-[72px] max-h-40 resize-none overflow-y-auto border-2 border-border pb-7 pr-16 text-base"
                  />
                  <span className="pointer-events-none absolute bottom-2 right-3 text-xs text-muted-foreground">
                    {sentence.length}/150
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {mode === "live" ? (
                    <Button onClick={handleTranslateClick} disabled={dictionaryLoading || isResolvingWords || !sentence.trim()}>
                      {dictionaryLoading || isResolvingWords ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      Translate
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => void showPreviousLearningSet()}
                        disabled={dictionaryLoading || isResolvingWords || learningHistoryIndex <= 0}
                      >
                        Back
                      </Button>
                      <Button
                        onClick={() => void showNextLearningSet()}
                        disabled={dictionaryLoading || isResolvingWords || originalDictionaryWords.length === 0}
                      >
                        {isResolvingWords ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        Next
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </section>

            {dictionaryError ? (
              <div className="text-sm text-red-600">{dictionaryError}</div>
            ) : null}
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="order-1 h-fit md:order-2 xl:sticky xl:top-24"
          >
            <div className="mx-auto w-full max-w-[360px] overflow-hidden rounded-3xl border-2 border-border bg-card shadow-lg md:max-w-none">
              <AvatarDisplay
                signData={currentSignData}
                isLoading={isSignLoading}
                error={playbackError}
                searchedWord={currentDisplayWord}
                isPlaybackActive={isPlaying}
                signStatus={playbackError ? null : currentSignData ? "available" : null}
                onPlaybackComplete={handleSentenceComplete}
                playbackKey={`${playbackVersion}-${currentSignData?.frames.length || 0}`}
                onActiveItemChange={setActiveSignedItem}
              />
            </div>

            <div className="mx-auto w-full max-w-[360px] md:max-w-none">
              <div className="mt-2 hidden flex-wrap items-center justify-between gap-3 md:flex">
                <Button variant="outline" onClick={handlePlaybackToggle} disabled={playableQueue.length === 0}>
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  {isPlaying ? "Pause" : "Play"}
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleFeedbackButtonClick("thumbs_up")}
                    disabled={!activeSignedItem}
                    aria-label="Mark current signed item as correct"
                    className={activeFeedback === "thumbs_up" ? "text-green-600 hover:text-green-700" : "text-muted-foreground"}
                  >
                    <ThumbsUp className={`w-5 h-5 ${activeFeedback === "thumbs_up" ? "fill-current" : ""}`} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleFeedbackButtonClick("thumbs_down")}
                    disabled={!activeSignedItem}
                    aria-label="Mark current signed item as incorrect"
                    className={activeFeedback === "thumbs_down" ? "text-red-600 hover:text-red-700" : "text-muted-foreground"}
                  >
                    <ThumbsDown className={`w-5 h-5 ${activeFeedback === "thumbs_down" ? "fill-current" : ""}`} />
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-center text-[11px] leading-4 text-muted-foreground">
                AI-generated signs can make mistakes. Check important translations.
              </p>
              <button
                key={adRefreshKey}
                type="button"
                onClick={handleAdClick}
                className="mt-2 flex h-11 w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
                aria-label="Ad placeholder"
              >
                Ad placeholder
              </button>
            </div>
            {sentenceAnimation?.missingWords.length ? (
              <div className="mt-2 text-center text-sm text-red-600">
                Missing from sentence timeline: {sentenceAnimation.missingWords.join(", ")}
              </div>
            ) : null}
          </motion.div>
        </div>
      </main>
      <footer className="mt-8 border-t border-border px-4 py-6 text-center text-sm text-muted-foreground">
        <nav className="flex flex-wrap items-center justify-center gap-4">
          <Link className="hover:text-foreground hover:underline" href="/contact">
            Contact Us
          </Link>
          <Link className="hover:text-foreground hover:underline" href="/terms">
            Terms and Conditions
          </Link>
          <Link className="hover:text-foreground hover:underline" href="/about">
            About Us
          </Link>
        </nav>
      </footer>
    </div>
  )
}
