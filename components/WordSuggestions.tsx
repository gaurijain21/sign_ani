"use client"

import { motion } from "framer-motion"
import { Badge } from "@/components/ui/badge"

interface WordSuggestionsProps {
  words: string[]
  onWordClick: (word: string) => void
  title?: string
}

export function WordSuggestions({ words, onWordClick, title = "Try these:" }: WordSuggestionsProps) {
  if (words.length === 0) {
    return null
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="space-y-3"
    >
      <p className="text-sm text-muted-foreground font-medium">{title}</p>
      <div className="flex flex-wrap gap-2">
        {words.map((word, index) => (
          <motion.div
            key={word}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 + index * 0.03 }}
          >
            <Badge
              variant="secondary"
              className="px-4 py-2 text-sm cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors rounded-full"
              onClick={() => onWordClick(word)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onWordClick(word)
                }
              }}
            >
              {word}
            </Badge>
          </motion.div>
        ))}
      </div>
    </motion.div>
  )
}
