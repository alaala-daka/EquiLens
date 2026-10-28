import "server-only"
import { authConfig } from "./config"
import { createAccountAccess } from "./handlers"
import { authServices } from "./runtime"

const access = createAccountAccess({ services: authServices, config: () => authConfig(process.env) })
export const requireAccount = access.requireAccount
export const revalidateAccountSession = access.revalidateAccountSession
