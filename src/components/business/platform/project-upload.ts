import { errorMessage } from "../../../lib/documents/types"

export type MaterialUploadSubmission = {
  upload(): Promise<unknown>
  refresh(): Promise<void>
  isCurrent(): boolean
  setBusy(busy: boolean): void
  setError(message: string): void
}

/**
 * Submit an already validated material form.
 *
 * Returns true only after the server accepted the upload and the visible list
 * was refreshed. The caller may close the sheet only on true; a failed upload
 * keeps the sheet open and leaves the visible error in place.
 */
export async function submitMaterialUpload(deps: MaterialUploadSubmission): Promise<boolean> {
  if (!deps.isCurrent()) return false
  deps.setBusy(true)
  deps.setError("")
  try {
    await deps.upload()
    if (!deps.isCurrent()) return false
    // The upload is accepted; a list refresh failure must not reopen the form
    // and must not turn the accepted material into a failed upload.
    try {
      await deps.refresh()
    } catch (failure) {
      if (deps.isCurrent()) deps.setError(errorMessage(failure))
    }
    return true
  } catch (failure) {
    if (deps.isCurrent()) deps.setError(errorMessage(failure))
    return false
  } finally {
    if (deps.isCurrent()) deps.setBusy(false)
  }
}
