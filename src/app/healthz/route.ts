export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", service: "equilens" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
