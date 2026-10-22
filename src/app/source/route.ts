export const dynamic = "force-dynamic"
export function GET() {
  const revision = process.env.SOURCE_COMMIT
  const ref = revision && /^[a-f0-9]{40}$/i.test(revision) ? revision : "main"
  return Response.redirect(`https://github.com/alaala-daka/EquiLens/tree/${ref}`, 307)
}
