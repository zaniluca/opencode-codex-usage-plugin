import { Logger as EffectLogger } from "effect"

export const layer = EffectLogger.layer([])

export const noopLayer = EffectLogger.layer([])

export * as Logger from "./logger.js"
