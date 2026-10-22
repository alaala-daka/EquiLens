import { NextResponse, type NextRequest } from "next/server"
import { documentRepository } from "@/server/documents/service"
import { creation, failureResponse, inputBody, sameOrigin, session, wire } from "@/server/documents/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const identity = session(request)
  try { return identity.apply(NextResponse.json(await (await documentRepository()).list(identity.owner))) }
  catch (failure) { return failureResponse(failure) }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request)
    const identity = session(request)
    const input = creation(await inputBody(request))
    const saved = await (await documentRepository()).create(identity.owner, input)
    return identity.apply(NextResponse.json(await wire(saved), { status: 201 }))
  } catch (failure) { return failureResponse(failure) }
}
