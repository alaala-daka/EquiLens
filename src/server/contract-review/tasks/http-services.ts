import "server-only"
import { documentReviewServices } from "../../documents/service"
import { reviewAvailability, reviewTaskRepository, submitRevision, submitReview } from "./service"
import { cancelRunningReview, wakeReviewRunner } from "./runner"
import type { ReviewHttpServices } from "./handlers"

export async function reviewHttpServices(): Promise<ReviewHttpServices> {
  const { sessions } = await documentReviewServices()
  return { sessions, repository: await reviewTaskRepository(), configuration: reviewAvailability,
    submit: submitReview, submitRevision, wake: wakeReviewRunner, cancel: cancelRunningReview }
}
