import "server-only"
import { requireAccount } from "../auth/access"
import { requireProjectAccess } from "../projects/access"
import { getTask, listTasks, submitTask } from "./service"
import { wakeTaskRunner } from "./runner"
export async function taskHttpServices() {
  return { identity: requireAccount, authorize: requireProjectAccess, get: getTask, list: listTasks,
    submit: async (...args: Parameters<typeof submitTask>) => { const result = await submitTask(...args); wakeTaskRunner(); return result } }
}
