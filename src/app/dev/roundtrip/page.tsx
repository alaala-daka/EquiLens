import { notFound } from "next/navigation"
import { RoundtripHarness } from "@/components/roundtrip-harness"

export const dynamic = "force-dynamic"

export default function Page() {
  if (process.env.EQUILENS_ROUNDRIP_HARNESS !== "1") notFound()
  return <RoundtripHarness />
}
