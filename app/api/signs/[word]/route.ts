import { NextResponse } from "next/server"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ word: string }> }
) {
  const { word } = await params
  const decodedWord = decodeURIComponent(word).toLowerCase().trim()
  const filename = decodedWord.replace(/\s+/g, "_")

  return NextResponse.redirect(new URL(`/data/signs/${encodeURIComponent(filename)}.json`, request.url))
}
