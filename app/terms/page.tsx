"use client"

import { useEffect } from "react"
import Link from "next/link"
import { trackSignWizEvent } from "@/lib/analytics"

export default function TermsPage() {
  useEffect(() => {
    void trackSignWizEvent("page_view_terms", { event_type: "page_view", page_title: "Terms and Conditions" })
  }, [])

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <Link className="text-sm text-muted-foreground hover:text-foreground hover:underline" href="/">
        Back to SignWiz
      </Link>
      <h1 className="mt-6 text-3xl font-bold">Terms and Conditions</h1>
      <p className="mt-4 text-muted-foreground">
        Placeholder terms and conditions for SignWiz. Replace this text with the final legal terms before launch.
      </p>
    </main>
  )
}
