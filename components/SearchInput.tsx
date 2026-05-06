"use client"

import { useState, useRef, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Search, X, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface SearchInputProps {
  onSearch: (word: string) => void
  suggestions: string[]
  isLoading?: boolean
  maxLength?: number
}

export function SearchInput({ 
  onSearch, 
  suggestions, 
  isLoading = false,
  maxLength = 50 
}: SearchInputProps) {
  const [value, setValue] = useState("")
  const [isFocused, setIsFocused] = useState(false)
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (value.trim()) {
      const filtered = suggestions.filter(s => 
        s.toLowerCase().startsWith(value.toLowerCase())
      ).slice(0, 6)
      setFilteredSuggestions(filtered)
      setSelectedIndex(-1)
    } else {
      setFilteredSuggestions([])
    }
  }, [value, suggestions])

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (value.trim() && !isLoading) {
      onSearch(value.trim().toLowerCase())
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filteredSuggestions.length === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex(prev => 
        prev < filteredSuggestions.length - 1 ? prev + 1 : prev
      )
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex(prev => prev > 0 ? prev - 1 : -1)
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault()
      const selected = filteredSuggestions[selectedIndex]
      setValue(selected)
      setFilteredSuggestions([])
      onSearch(selected.toLowerCase())
    } else if (e.key === "Escape") {
      setFilteredSuggestions([])
      setSelectedIndex(-1)
    }
  }

  const handleSuggestionClick = (suggestion: string) => {
    setValue(suggestion)
    setFilteredSuggestions([])
    onSearch(suggestion.toLowerCase())
    inputRef.current?.focus()
  }

  const clearInput = () => {
    setValue("")
    setFilteredSuggestions([])
    inputRef.current?.focus()
  }

  return (
    <div className="relative w-full">
      <form onSubmit={handleSubmit} className="relative">
        <div className="relative">
          <Search 
            className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" 
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setTimeout(() => setIsFocused(false), 200)}
            onKeyDown={handleKeyDown}
            placeholder="Type a word..."
            maxLength={maxLength}
            className="pl-12 pr-24 py-6 text-lg rounded-2xl border-2 border-border focus:border-primary transition-colors"
            aria-label="Search for a sign"
            aria-autocomplete="list"
            aria-controls="suggestions-list"
            aria-expanded={filteredSuggestions.length > 0 && isFocused}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={clearInput}
                className="h-8 w-8 rounded-full"
                aria-label="Clear input"
              >
                <X className="w-4 h-4" />
              </Button>
            )}
            <Button 
              type="submit" 
              disabled={!value.trim() || isLoading}
              className="rounded-xl px-4"
              aria-label="Search"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Search"
              )}
            </Button>
          </div>
        </div>

        {/* Character count */}
        <div className="absolute -bottom-6 right-2 text-xs text-muted-foreground">
          {value.length}/{maxLength}
        </div>
      </form>

      {/* Suggestions dropdown */}
      <AnimatePresence>
        {filteredSuggestions.length > 0 && isFocused && (
          <motion.ul
            id="suggestions-list"
            role="listbox"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full left-0 right-0 mt-2 bg-card border-2 border-border rounded-xl shadow-lg overflow-hidden z-50"
          >
            {filteredSuggestions.map((suggestion, index) => (
              <li
                key={suggestion}
                role="option"
                aria-selected={index === selectedIndex}
                onClick={() => handleSuggestionClick(suggestion)}
                className={`px-4 py-3 cursor-pointer transition-colors ${
                  index === selectedIndex 
                    ? "bg-primary text-primary-foreground" 
                    : "hover:bg-muted"
                }`}
              >
                <span className="font-medium">{suggestion}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}
