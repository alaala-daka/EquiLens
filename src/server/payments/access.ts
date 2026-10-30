import "server-only"
import { applicationDatabase } from "../database/runtime"
import { FactRepository } from "../facts/repository"
import { MaterialRepository } from "../materials/repository"
import { resultHttpServices } from "../results/access"
import { PaymentsService } from "./service"

export async function paymentsHttpServices() {
  const results = await resultHttpServices()
  const database = await applicationDatabase()
  return { identity: results.identity, authorize: results.authorize, service: new PaymentsService({
    results: results.service, facts: new FactRepository(database), materials: new MaterialRepository(database),
  }) }
}
