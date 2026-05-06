import { NextResponse } from "next/server"
import { 
  getAvailableWords, 
  getSuggestedWords, 
  getManifestStats,
  searchWords 
} from "@/lib/manifest"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const query = searchParams.get("q")
  
  // If search query provided, return search results
  if (query) {
    const results = await searchWords(query, 15)
    return NextResponse.json({ results })
  }
  
  // Otherwise return full word list and stats
  const [words, suggested, stats] = await Promise.all([
    getAvailableWords(),
    getSuggestedWords(),
    getManifestStats(),
  ])
  
  return NextResponse.json({
    words,
    suggested,
    stats,
    total: words.length,
  })
}
