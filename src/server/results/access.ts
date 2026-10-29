import "server-only"
import { applicationDatabase } from "../database/runtime"
import { requireAccount } from "../auth/access"
import { requireProjectAccess } from "../projects/access"
import { ResultRepository } from "./repository"
import { productionResultValidators } from "./registry"
import { ResultService } from "./service"
export async function resultHttpServices() {
  return { identity: requireAccount, authorize: requireProjectAccess, service: new ResultService(new ResultRepository(await applicationDatabase()), productionResultValidators()) }
}
