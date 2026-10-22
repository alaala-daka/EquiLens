import { NextResponse, type NextRequest } from "next/server"
import { documentRepository } from "@/server/documents/service"
import { failureResponse, identifier, inputBody, sameOrigin, session, wire } from "@/server/documents/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: Context) {
  try {
    const identity = session(request)
    const id = identifier((await context.params).id)
    const opened = await (await documentRepository()).open(identity.owner, id)
    return identity.apply(NextResponse.json(await wire(opened)))
  } catch (failure) { return failureResponse(failure) }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    sameOrigin(request)
    const identity = session(request)
    const body = await inputBody(request)
    const input = { documentId: identifier((await context.params).id), baseRevision: identifier(body.baseRevision), operationId: identifier(body.operationId), title: body.title, prompt: body.prompt, blob: body.blob }
    const saved = await (await documentRepository()).save(identity.owner, input)
    return identity.apply(NextResponse.json(await wire(saved)))
  } catch (failure) { return failureResponse(failure) }
}
