import { NextResponse } from "next/server"
import { loadSignData, getWordStatus } from "@/lib/manifest"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ word: string }> }
) {
  const { word } = await params
  const decodedWord = decodeURIComponent(word).toLowerCase().trim()
  
  // Get word status
  const { status, entry } = await getWordStatus(decodedWord)
  
  // Load sign data
  const { data, source, error } = await loadSignData(decodedWord)
  
  if (error && !data) {
    // Return appropriate error based on status
    return NextResponse.json(
      { 
        error, 
        word: decodedWord,
        status,
        inWlasl: status !== "not_in_wlasl",
        entry,
      },
      { status: status === "not_in_wlasl" ? 404 : 409 }
    )
  }

  return NextResponse.json({
    ...data,
    status,
    source,
    entry,
  })
}
